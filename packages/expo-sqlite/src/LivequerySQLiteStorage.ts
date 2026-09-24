import { queryDocs, type Doc, type LivequeryPaging, type LivequeryStorage, type ParitalDocState } from '@livequery/client'
import { uuidv7 } from 'uuidv7'

type Bind = string | number | null

/**
 * The part of expo-sqlite's `SQLiteDatabase` this storage uses. An expo-sqlite database fits as is;
 * tests can pass anything shaped like it (e.g. a wrapper around `bun:sqlite`).
 */
export type SQLiteDatabaseLike = {
    execAsync(source: string): Promise<void>
    runAsync(source: string, ...params: Bind[]): Promise<unknown>
    getAllAsync<T>(source: string, ...params: Bind[]): Promise<T[]>
    getFirstAsync<T>(source: string, ...params: Bind[]): Promise<T | null>
    withExclusiveTransactionAsync(task: (transaction: SQLiteDatabaseLike) => Promise<void>): Promise<void>
    closeAsync(): Promise<void>
}

export type LivequerySQLiteStorageOptions = {
    /** Database file name, without `.db`. Two storages with the same name share their data. Default `livequery`. */
    name: string
    /** An open database to use instead of opening `name` (tests: an in-memory database). */
    database: SQLiteDatabaseLike
    /**
     * Keep each collection in memory once it has been read, and answer from there. Writes go to
     * SQLite first, then to memory. Default true. Needs this storage to be the only writer of its
     * database (see the README).
     */
    cache: boolean
}

type Row = { id: string, doc: string }

const TABLE = 'livequery_docs'

/**
 * `LivequeryStorage` on expo-sqlite, for React Native / Expo, where there is no IndexedDB.
 * Everything survives an app restart: documents, pending writes, the outbox and the sync's
 * bookkeeping — to the client they are all collections.
 *
 * One table holds every collection under the primary key `(collection, id)`, a document as JSON.
 * `query()` runs the same `queryDocs` as the memory storage over the collection, so filters, sort
 * order, totals and cursors are identical; with `cache` (the default) the collection is read
 * from SQLite once and kept in memory, so later queries cost what the memory storage costs.
 *
 * Operations run one at a time, in call order. The storage assumes it is the only writer of its
 * database: one client per app process, which is what an app has.
 */
export class LivequerySQLiteStorage implements LivequeryStorage {
    readonly #name: string
    readonly #given: SQLiteDatabaseLike | undefined
    readonly #cache: Map<string, Map<string, Doc>> | undefined
    #db: Promise<SQLiteDatabaseLike> | undefined
    #queue: Promise<unknown> = Promise.resolve()

    constructor(options: Partial<LivequerySQLiteStorageOptions> = {}) {
        this.#name = options.name ?? 'livequery'
        this.#given = options.database
        this.#cache = options.cache === false ? undefined : new Map()
    }

    query<T extends Doc>(collection: string, filters?: Record<string, any>): Promise<{ documents: T[], paging: LivequeryPaging }> {
        return this.#serial(async db => {
            const docs = await this.#collection(db, collection)
            return queryDocs([...docs.values()] as T[], filters)
        })
    }

    get<T extends Doc>(ref: string, id: string): Promise<T | null> {
        return this.#serial(async db => (await this.#get(db, ref, id)) as T | null)
    }

    add<T extends Doc>(collection: string, document: ParitalDocState<T>) {
        return this.#serial(async db => {
            const doc = { ...document, id: document.id || `local:${uuidv7()}` } as T
            return await this.#put(db, collection, doc) as T
        })
    }

    update<T extends Doc>(collection: string, id: string, document: Record<string, any>): Promise<T | null> {
        return this.#serial(async db => {
            const existing = await this.#get(db, collection, id)
            if (!existing) return null
            const next = { ...existing, ...document } as Doc
            const next_id = document.id && document.id !== id ? String(document.id) : id
            if (next_id === id) return await this.#put(db, collection, next) as T
            // The outbox swaps a `local:` id for the server id here: both statements or neither.
            const json = JSON.stringify(next)
            await db.withExclusiveTransactionAsync(async transaction => {
                await transaction.runAsync(`DELETE FROM ${TABLE} WHERE collection = ? AND id = ?`, collection, id)
                await transaction.runAsync(`INSERT OR REPLACE INTO ${TABLE} (collection, id, doc) VALUES (?, ?, ?)`, collection, next_id, json)
            })
            const stored = JSON.parse(json) as Doc
            const cached = this.#cache?.get(collection)
            cached?.delete(id)
            cached?.set(next_id, stored)
            return stored as T
        })
    }

    delete<T extends Doc>(collection: string, id: string): Promise<T | null> {
        return this.#serial(async db => {
            const existing = await this.#get(db, collection, id)
            if (!existing) return null
            await db.runAsync(`DELETE FROM ${TABLE} WHERE collection = ? AND id = ?`, collection, id)
            this.#cache?.get(collection)?.delete(id)
            return existing as T
        })
    }

    flush(): Promise<void> {
        return this.#serial(async db => {
            await db.runAsync(`DELETE FROM ${TABLE}`)
            this.#cache?.clear()
        })
    }

    /** Close the database this storage opened (not one passed in). The next call reopens it. */
    close(): Promise<void> {
        return this.#serial(async db => {
            this.#db = undefined
            this.#cache?.clear()
            if (!this.#given) await db.closeAsync()
        })
    }

    // ── Internal ───────────────────────────────────────────────────────────────

    // One operation at a time: a read-modify-write never interleaves with another write.
    #serial<R>(task: (db: SQLiteDatabaseLike) => Promise<R>): Promise<R> {
        const run = this.#queue.then(() => this.#open()).then(task)
        this.#queue = run.catch(() => undefined)
        return run
    }

    #open() {
        this.#db ??= (async () => {
            // Imported only when used, so tests and other runtimes never load the native module.
            const db = this.#given ?? await (await import('expo-sqlite')).openDatabaseAsync(`${this.#name}.db`) as unknown as SQLiteDatabaseLike
            await db.execAsync(`
                PRAGMA journal_mode = WAL;
                PRAGMA synchronous = NORMAL;
                CREATE TABLE IF NOT EXISTS ${TABLE} (
                    collection TEXT NOT NULL,
                    id TEXT NOT NULL,
                    doc TEXT NOT NULL,
                    PRIMARY KEY (collection, id)
                ) WITHOUT ROWID;
            `)
            return db
        })().catch(e => {
            this.#db = undefined
            throw e
        })
        return this.#db
    }

    // A collection's documents: from memory once read, else from SQLite (and kept, with `cache`).
    async #collection(db: SQLiteDatabaseLike, collection: string) {
        const cached = this.#cache?.get(collection)
        if (cached) return cached
        const rows = await db.getAllAsync<Row>(`SELECT id, doc FROM ${TABLE} WHERE collection = ?`, collection)
        const docs = new Map(rows.map(row => [row.id, JSON.parse(row.doc) as Doc]))
        this.#cache?.set(collection, docs)
        return docs
    }

    async #get(db: SQLiteDatabaseLike, collection: string, id: string): Promise<Doc | null> {
        const cached = this.#cache?.get(collection)
        if (cached) return cached.get(id) ?? null
        const row = await db.getFirstAsync<Pick<Row, 'doc'>>(`SELECT doc FROM ${TABLE} WHERE collection = ? AND id = ?`, collection, id)
        return row ? JSON.parse(row.doc) as Doc : null
    }

    // Write a document; memory holds what SQLite holds (the JSON round trip drops `undefined`).
    async #put(db: SQLiteDatabaseLike, collection: string, doc: Doc) {
        const json = JSON.stringify(doc)
        await db.runAsync(`INSERT OR REPLACE INTO ${TABLE} (collection, id, doc) VALUES (?, ?, ?)`, collection, doc.id, json)
        const stored = JSON.parse(json) as Doc
        this.#cache?.get(collection)?.set(doc.id, stored)
        return stored
    }
}
