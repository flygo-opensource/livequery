import { uuidv7 } from 'uuidv7'
import type { Doc, LivequeryPaging, ParitalDocState } from './types.js'
import type { LivequeryStorage } from './LivequeryStorage.js'
import { LivequeryMemoryStorage } from './LivequeryMemoryStorage.js'
import { queryDocs } from './helpers/queryDocs.js'
import { getByPath } from './helpers/filterDocs.js'
import { CURSOR_INDEX, decodeCursor, encodeCursor } from './helpers/paginateDocs.js'
import { idRank, rankOf, sortersOf, TYPE_RANK, type Sorter } from './helpers/sortDocs.js'

export type LivequeryIndexedDBStorageOptions = {
    /** Database name. Two storages with the same name share their data. Default `livequery`. */
    name: string
    /**
     * Ask the browser to exempt the origin from storage eviction (`navigator.storage.persist()`).
     * Worth it for offline-first apps; Safari still evicts origins unused for ~7 days.
     */
    persist: boolean
    /** IDBFactory to use instead of the global `indexedDB` (tests, embedded runtimes). */
    indexedDB: IDBFactory
    /** `IDBKeyRange` to go with `indexedDB`, when it is not the global one. */
    keyRange: typeof IDBKeyRange
    /**
     * A collection this large gets an index on the field it is sorted by, so a page reads one page
     * instead of the whole collection. Every index costs a little on every write. Default 500.
     */
    indexAfter: number
}

type Row = {
    collection: string
    id: string
    doc: Doc
    /** One key per sort index of the database (see `indexFields`). */
    keys?: Record<string, IDBValidKey>
    /** The id as MongoDB orders it (`idRank`): the tie-break of every index. */
    idkey?: IDBValidKey
    /** `collection|path` of each indexed field holding an array or object: no index key for it. */
    odd?: string[]
}

const STORE = 'docs'
const BY_COLLECTION = 'by_collection'
// Rows holding how many documents a collection has: `{ id: collection, count }`.
const COUNTS = '__livequery_counts'
const SORT_INDEX_PREFIX = 'order:'
// Indexes from before sort keys followed MongoDB's order; dropped at the next upgrade.
const STALE_INDEX_PREFIX = 'sort:'
const BY_ID = 'by_id'
const ODD = 'odd'
const sortIndex = (path: string) => `${SORT_INDEX_PREFIX}${path}`
// An index key path is dot-separated identifiers; `$` is kept free to flatten a path.
const PATH_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const flat = (path: string) => path.split('.').join('$')
// Above every `[rank, value]` key: `[collection, HIGHEST]` bounds a whole collection.
const HIGHEST = [Infinity]

// IndexedDB compares strings by UTF-16 unit, MongoDB by code point. Moving the units of U+E000…
// U+FFFF below the surrogates (and those above) makes the first order the second.
const codePointOrder = (value: string) => {
    let out = ''
    for (let i = 0; i < value.length; i++) {
        const unit = value.charCodeAt(i)
        out += String.fromCharCode(unit >= 0xE000 ? unit - 0x800 : unit >= 0xD800 ? unit + 0x2000 : unit)
    }
    return out
}

/**
 * A value's index key in MongoDB's order: `[type rank, value]`. Null when no index key can order it
 * like MongoDB (an array sorts by its smallest or largest element depending on the direction; an
 * object field by field) — the row is then marked `odd` and such queries read the collection.
 */
function sortKey(value: unknown): IDBValidKey | null {
    const rank = rankOf(value)
    if (rank === TYPE_RANK.null) return [rank]
    if (rank === TYPE_RANK.number) return Number.isNaN(value) ? null : [rank, value as number]
    if (rank === TYPE_RANK.string) return [rank, codePointOrder(value as string)]
    if (rank === TYPE_RANK.boolean) return [rank, value ? 1 : 0]
    return null
}

const idKey = (id: string): IDBValidKey => {
    const [rank, value] = idRank(id)
    return [rank, codePointOrder(value)]
}

// What a row carries for the indexes: a key per sort index, its id key, and the fields it cannot key.
function indexFields(collection: string, doc: Record<string, any>, indexes: DOMStringList): Pick<Row, 'keys' | 'idkey' | 'odd'> {
    const keys: Record<string, IDBValidKey> = {}
    const odd: string[] = []
    for (const name of Array.from(indexes)) {
        if (!name.startsWith(SORT_INDEX_PREFIX)) continue
        const path = name.slice(SORT_INDEX_PREFIX.length)
        const key = sortKey(getByPath(doc, path))
        if (key === null) odd.push(`${collection}|${path}`)
        else keys[flat(path)] = key
    }
    return { keys, idkey: idKey(String(doc.id)), ...odd.length > 0 ? { odd } : {} }
}

// A query an index answers on its own: one page, sorted by one field (or by id), nothing to filter.
type Plan = {
    path: string | null
    sorters: Sorter[]
    direction: 'asc' | 'desc'
    limit: number
    after?: Record<string, any>
    before?: Record<string, any>
}

type Page<T> = { documents: T[], paging: LivequeryPaging }

function planOf(filters: Record<string, any> = {}): Plan | null {
    let limit: number | undefined
    let after: unknown
    let before: unknown
    let path: string | null = null
    for (const [key, value] of Object.entries(filters)) {
        if (value === undefined || value === null) continue
        if (key === ':limit') limit = Number(value)
        else if (key === ':after') after = value
        else if (key === ':before') before = value
        else if (key.endsWith(':sort') && path === null) path = key.slice(0, -5)
        else return null
    }
    if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return null
    if (after !== undefined && before !== undefined) return null
    if (path !== null && !path.split('.').every(segment => PATH_SEGMENT.test(segment))) return null
    const sorters = sortersOf(filters)
    const cursor = after ?? before
    const position = cursor === undefined ? undefined : typeof cursor === 'string' ? decodeCursor(cursor) : null
    if (position === null) return null
    if (position && typeof position.id !== 'string') return null
    return {
        path,
        sorters,
        direction: sorters[0]?.[1] ?? 'desc',
        limit,
        ...after !== undefined ? { after: position } : {},
        ...before !== undefined ? { before: position } : {},
    }
}

/**
 * `LivequeryStorage` on IndexedDB, with no runtime dependency. One object store holds every
 * collection under the composite key `[collection, id]`: IndexedDB only creates stores during a
 * version upgrade, and collection refs are only known at runtime.
 *
 * `query()` answers a plain page (`:limit`, `:after` / `:before`, one `field:sort`) from an index,
 * reading only that page; any other query loads the collection and runs the same `queryDocs` as
 * the memory storage. Both put documents in the same order.
 *
 * Page counts from an index: `total` is exact (kept per collection on every write), whether a
 * next / previous page exists is exact, and `next.count` / `prev.count` come from the position the
 * cursor carries — exact unless documents were added or removed before the page since.
 *
 * Where `indexedDB` does not exist (SSR, Node, Bun) it falls back to an in-memory storage.
 */
export class LivequeryIndexedDBStorage implements LivequeryStorage {
    readonly shared: string | undefined

    readonly #name: string
    readonly #factory: IDBFactory | undefined
    readonly #keyRange: typeof IDBKeyRange | undefined
    readonly #indexAfter: number
    readonly #fallback = new LivequeryMemoryStorage()
    // Sort fields whose index is being created.
    readonly #indexing = new Set<string>()

    #db: Promise<IDBDatabase> | undefined

    constructor(options: Partial<LivequeryIndexedDBStorageOptions> = {}) {
        this.#name = options.name ?? 'livequery'
        this.#factory = options.indexedDB ?? (typeof indexedDB === 'undefined' ? undefined : indexedDB)
        this.#keyRange = options.keyRange ?? (typeof IDBKeyRange === 'undefined' ? undefined : IDBKeyRange)
        this.#indexAfter = options.indexAfter ?? 500
        this.shared = this.#factory ? `indexeddb:${this.#name}` : undefined
        if (options.persist && this.#factory) {
            globalThis.navigator?.storage?.persist?.().catch(() => undefined)
        }
    }

    async query<T extends Doc>(collection: string, filters?: Record<string, any>): Promise<{
        documents: T[]
        paging: LivequeryPaging
    }> {
        if (!this.#factory) return this.#fallback.query<T>(collection, filters)
        const plan = this.#keyRange ? planOf(filters) : null
        if (plan) {
            const page = await this.#indexedPage<T>(collection, plan)
            if (page) return page
        }
        const { sources, counted } = await this.#transaction<{ sources: T[], counted: boolean }>('readonly', (store, done) => {
            const request = store.index(BY_COLLECTION).getAll(collection)
            const counter = store.getKey([COUNTS, collection])
            // Requests finish in the order they were made: the last one sees both results.
            counter.onsuccess = () => done({
                sources: (request.result as Row[]).map(row => row.doc as T),
                counted: counter.result !== undefined,
            })
        })
        if (plan && !counted) this.#startCounting(collection).catch(() => undefined)
        // Big enough to be worth an index for next time.
        if (plan && sources.length >= this.#indexAfter) this.#createIndex(plan.path)
        return queryDocs(sources, filters)
    }

    async get<T extends Doc>(ref: string, id: string): Promise<T | null> {
        if (!this.#factory) return this.#fallback.get<T>(ref, id)
        return await this.#transaction<T | null>('readonly', (store, done) => {
            const request = store.get([ref, id])
            request.onsuccess = () => done((request.result as Row | undefined)?.doc as T ?? null)
        })
    }

    async add<T extends Doc>(collection: string, document: ParitalDocState<T>) {
        if (!this.#factory) return this.#fallback.add<T>(collection, document)
        const doc = {
            ...document,
            id: document.id || `local:${uuidv7()}`,
        } as T
        return await this.#transaction<T>('readwrite', (store, done) => {
            const existing = store.getKey([collection, doc.id])
            existing.onsuccess = () => {
                store.put({ collection, id: doc.id, doc, ...indexFields(collection, doc, store.indexNames) } satisfies Row)
                if (existing.result === undefined) this.#count(store, collection, +1)
                done(doc)
            }
        })
    }

    async update<T extends Doc>(collection: string, id: string, document: Record<string, any>): Promise<T | null> {
        if (!this.#factory) return this.#fallback.update<T>(collection, id, document)
        // Read, re-key and write in ONE transaction: the outbox swaps a `local:` id for the server
        // id through here, and a crash between the delete and the put would lose the document.
        return await this.#transaction<T | null>('readwrite', (store, done) => {
            const request = store.get([collection, id])
            request.onsuccess = () => {
                const row = request.result as Row | undefined
                if (!row) return done(null)
                const next = { ...row.doc, ...document } as T
                const next_id = document.id && document.id !== id ? document.id as string : id
                next_id !== id && store.delete([collection, id])
                store.put({ collection, id: next_id, doc: next, ...indexFields(collection, next, store.indexNames) } satisfies Row)
                done(next)
            }
        })
    }

    async delete<T extends Doc>(collection: string, id: string): Promise<T | null> {
        if (!this.#factory) return this.#fallback.delete<T>(collection, id)
        return await this.#transaction<T | null>('readwrite', (store, done) => {
            const request = store.get([collection, id])
            request.onsuccess = () => {
                const row = request.result as Row | undefined
                if (row) {
                    store.delete([collection, id])
                    this.#count(store, collection, -1)
                }
                done(row?.doc as T ?? null)
            }
        })
    }

    async flush(): Promise<void> {
        if (!this.#factory) return this.#fallback.flush()
        await this.#transaction<void>('readwrite', (store, done) => {
            store.clear()
            done()
        })
    }

    /** Close the connection. Safe to call twice; the next call reopens it. */
    async close() {
        const db = this.#db
        this.#db = undefined
        if (!db) return
        const connection = await db.catch(() => undefined)
        connection?.close()
    }

    // ── Internal ───────────────────────────────────────────────────────────────

    // Count a collection once, in the transaction that stores the count, so no write slips between.
    #startCounting(collection: string) {
        return this.#transaction<void>('readwrite', (store, done) => {
            const existing = store.getKey([COUNTS, collection])
            const count = store.index(BY_COLLECTION).count(collection)
            count.onsuccess = () => {
                if (existing.result === undefined) {
                    store.put({ collection: COUNTS, id: collection, doc: { id: collection, count: count.result } as Doc })
                }
                done()
            }
        })
    }

    // Keep a collection's count, once one exists (the first scan of the collection starts it).
    #count(store: IDBObjectStore, collection: string, delta: number) {
        const request = store.get([COUNTS, collection])
        request.onsuccess = () => {
            const row = request.result as Row | undefined
            if (!row) return
            const count = Math.max(0, (row.doc as unknown as { count: number }).count + delta)
            store.put({ ...row, doc: { id: collection, count } as Doc })
        }
    }

    // One page read from an index — or from the primary key `[collection, id]` when the page is
    // sorted by id. Null when the index or the collection's count does not exist yet.
    async #indexedPage<T extends Doc>(collection: string, plan: Plan): Promise<Page<T> | null> {
        const range = this.#keyRange!
        const keyOf = (doc: Record<string, any>) => plan.path === null
            ? [collection, idKey(String(doc.id))]
            : [collection, sortKey(getByPath(doc, plan.path))!, idKey(String(doc.id))]
        const whole = range.bound([collection], [collection, HIGHEST])
        const position = plan.after ?? plan.before
        // Walking towards later documents in index order? `:before` walks back against the order.
        const ascending = (plan.direction === 'asc') !== (plan.before !== undefined)
        const beyond = (doc: Record<string, any>, up: boolean) => up
            ? range.bound(keyOf(doc), [collection, HIGHEST], true, false)
            : range.bound([collection], keyOf(doc), false, true)

        return await this.#transaction<Page<T> | null>('readonly', (store, done) => {
            const name = plan.path === null ? BY_ID : sortIndex(plan.path)
            if (!store.indexNames.contains(name)) return done(null)
            const source = store.index(name)

            // Documents whose field holds an array or object are not in the index: read them all.
            const odd = plan.path === null ? null : store.index(ODD).count(`${collection}|${plan.path}`)
            const counted = store.get([COUNTS, collection])
            counted.onsuccess = () => {
                const counter = counted.result as Row | undefined
                if (!counter || (odd && odd.result > 0)) return done(null)
                const total = (counter.doc as unknown as { count: number }).count

                // One more than the page: whether another page follows in this direction.
                const walked: T[] = []
                const walk = source.openCursor(position ? beyond(position, ascending) : whole, ascending ? 'next' : 'prev')
                walk.onsuccess = () => {
                    const cursor = walk.result
                    if (cursor && walked.length <= plan.limit) {
                        walked.push((cursor.value as Row).doc as T)
                        return cursor.continue()
                    }
                    const more = walked.length > plan.limit
                    const documents = walked.slice(0, plan.limit)
                    if (plan.before !== undefined) documents.reverse()
                    const first = documents[0]
                    const last = documents.at(-1)
                    if (!first || !last) return done({ documents, paging: { total, current: 0 } })

                    // And whether anything lies on the other side of the page: one key.
                    const edge = plan.before !== undefined ? last : first
                    const other = source.openKeyCursor(beyond(edge, !ascending), ascending ? 'prev' : 'next')
                    other.onsuccess = () => {
                        const has_other = !!other.result
                        const [has_next, has_prev] = plan.before !== undefined ? [has_other, more] : [more, has_other]
                        const finish = (first_index: number) => {
                            const next_count = Math.max(1, total - first_index - documents.length)
                            const prev_count = Math.max(1, first_index)
                            done({
                                documents,
                                paging: {
                                    total,
                                    current: documents.length,
                                    ...has_next ? { next: { count: next_count, cursor: encodeCursor(last, plan.sorters, first_index + documents.length - 1) } } : {},
                                    ...has_prev ? { prev: { count: prev_count, cursor: encodeCursor(first, plan.sorters, first_index) } } : {},
                                },
                            })
                        }
                        // Where the page starts: from the cursor's index, or counted when it has none.
                        const index = position?.[CURSOR_INDEX]
                        if (!position) return finish(0)
                        if (typeof index === 'number') return finish(plan.after !== undefined ? index + 1 : Math.max(0, index - documents.length))
                        if (!has_prev) return finish(0)
                        const before_first = source.count(beyond(first, plan.direction !== 'asc'))
                        before_first.onsuccess = () => finish(before_first.result)
                    }
                }
            }
        })
    }

    // Indexes are created in a version upgrade: close, reopen one version up. Other connections
    // to the database close themselves on `versionchange` and reopen on their next request.
    // `path` null: the id index, for pages sorted by id.
    #createIndex(path: string | null) {
        const name = path === null ? BY_ID : sortIndex(path)
        if (this.#indexing.has(name)) return
        this.#indexing.add(name)
        const previous = this.#open()
        const upgraded: Promise<IDBDatabase> = previous.then(db => {
            if (db.transaction(STORE, 'readonly').objectStore(STORE).indexNames.contains(name)) return db
            db.close()
            return this.#connect(db.version + 1, path)
        })
        const settled = upgraded.catch(() => {
            // Someone else upgraded first (VersionError), or the upgrade failed: reopen as is;
            // a later query asks again.
            if (this.#db === settled) this.#db = undefined
            return this.#open()
        }).finally(() => this.#indexing.delete(name))
        this.#db = settled
    }

    #open() {
        this.#db ??= this.#connect()
        return this.#db
    }

    // `version` undefined opens the current version (creating version 1 the first time).
    #connect(version?: number, index?: string | null) {
        const connection = new Promise<IDBDatabase>((resolve, reject) => {
            const request = version === undefined ? this.#factory!.open(this.#name) : this.#factory!.open(this.#name, version)
            request.onupgradeneeded = event => {
                const store = event.oldVersion === 0
                    ? request.result.createObjectStore(STORE, { keyPath: ['collection', 'id'] })
                    : request.transaction!.objectStore(STORE)
                if (!store.indexNames.contains(BY_COLLECTION)) store.createIndex(BY_COLLECTION, 'collection')
                if (index === undefined) return
                for (const name of Array.from(store.indexNames)) name.startsWith(STALE_INDEX_PREFIX) && store.deleteIndex(name)
                if (!store.indexNames.contains(BY_ID)) store.createIndex(BY_ID, ['collection', 'idkey'])
                if (!store.indexNames.contains(ODD)) store.createIndex(ODD, 'odd', { multiEntry: true })
                if (index !== null && !store.indexNames.contains(sortIndex(index))) {
                    store.createIndex(sortIndex(index), ['collection', `keys.${flat(index)}`, 'idkey'])
                }
                // Every row gets its keys for the indexes, so each index holds every document it can.
                const rows = store.openCursor()
                rows.onsuccess = () => {
                    const cursor = rows.result
                    if (!cursor) return
                    const row = cursor.value as Row
                    if (row.collection !== COUNTS) cursor.update({ ...row, ...indexFields(row.collection, row.doc, store.indexNames) })
                    cursor.continue()
                }
            }
            request.onsuccess = () => {
                const db = request.result
                // Let another connection upgrade the schema instead of blocking it forever.
                db.onversionchange = () => {
                    db.close()
                    if (this.#db === connection) this.#db = undefined
                }
                resolve(db)
            }
            request.onerror = () => {
                if (this.#db === connection) this.#db = undefined
                reject(request.error)
            }
        })
        return connection
    }

    // Requests are issued from inside IDB callbacks, never after an `await`, so the transaction
    // cannot auto-commit halfway through a read-modify-write.
    async #transaction<R>(
        mode: IDBTransactionMode,
        body: (store: IDBObjectStore, done: (result: R) => void) => void,
    ): Promise<R> {
        // The constructor only lets public methods reach here when a factory exists.
        const pending = this.#open()
        let transaction: IDBTransaction
        try {
            transaction = (await pending).transaction(STORE, mode)
        } catch (e) {
            // The connection closed under us (an index being added, another tab upgrading): once more.
            if ((e as DOMException)?.name !== 'InvalidStateError') throw e
            if (this.#db === pending) this.#db = undefined
            transaction = (await this.#open()).transaction(STORE, mode)
        }
        return await new Promise<R>((resolve, reject) => {
            let result: R
            transaction.oncomplete = () => resolve(result)
            transaction.onerror = () => reject(transaction.error)
            transaction.onabort = () => reject(transaction.error)
            body(transaction.objectStore(STORE), value => { result = value })
        })
    }
}
