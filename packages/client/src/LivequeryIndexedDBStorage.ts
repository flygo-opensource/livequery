import { uuidv7 } from 'uuidv7'
import type { Doc, LivequeryPaging, ParitalDocState } from './types.js'
import type { LivequeryStorage } from './LivequeryStorage.js'
import { LivequeryMemoryStorage } from './LivequeryMemoryStorage.js'
import { queryDocs } from './helpers/queryDocs.js'

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
}

type Row = {
    collection: string
    id: string
    doc: Doc
}

const STORE = 'docs'
const BY_COLLECTION = 'by_collection'

/**
 * `LivequeryStorage` on IndexedDB, with no runtime dependency. One object store holds every
 * collection under the composite key `[collection, id]`: IndexedDB only creates stores during a
 * version upgrade, and collection refs are only known at runtime.
 *
 * `query()` loads the collection and filters it with the same `filterDocs` as the memory storage,
 * so both adapters answer a query identically.
 *
 * Where `indexedDB` does not exist (SSR, Node, Bun) it falls back to an in-memory storage.
 */
export class LivequeryIndexedDBStorage implements LivequeryStorage {
    readonly shared: string | undefined

    readonly #name: string
    readonly #factory: IDBFactory | undefined
    readonly #fallback = new LivequeryMemoryStorage()

    #db: Promise<IDBDatabase> | undefined

    constructor(options: Partial<LivequeryIndexedDBStorageOptions> = {}) {
        this.#name = options.name ?? 'livequery'
        this.#factory = options.indexedDB ?? (typeof indexedDB === 'undefined' ? undefined : indexedDB)
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
        const sources = await this.#transaction<T[]>('readonly', (store, done) => {
            const request = store.index(BY_COLLECTION).getAll(collection)
            request.onsuccess = () => done((request.result as Row[]).map(row => row.doc as T))
        })
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
            store.put({ collection, id: doc.id, doc } satisfies Row)
            done(doc)
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
                store.put({ collection, id: next_id, doc: next } satisfies Row)
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
                row && store.delete([collection, id])
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

    #open(factory: IDBFactory) {
        this.#db ??= new Promise<IDBDatabase>((resolve, reject) => {
            const request = factory.open(this.#name, 1)
            request.onupgradeneeded = () => {
                const store = request.result.createObjectStore(STORE, { keyPath: ['collection', 'id'] })
                store.createIndex(BY_COLLECTION, 'collection')
            }
            request.onsuccess = () => {
                const db = request.result
                // Let another tab upgrade the schema instead of blocking it forever.
                db.onversionchange = () => {
                    db.close()
                    this.#db = undefined
                }
                resolve(db)
            }
            request.onerror = () => {
                this.#db = undefined
                reject(request.error)
            }
        })
        return this.#db
    }

    // Requests are issued from inside IDB callbacks, never after an `await`, so the transaction
    // cannot auto-commit halfway through a read-modify-write.
    async #transaction<R>(
        mode: IDBTransactionMode,
        body: (store: IDBObjectStore, done: (result: R) => void) => void,
    ): Promise<R> {
        // The constructor only lets public methods reach here when a factory exists.
        const db = await this.#open(this.#factory!)
        return await new Promise<R>((resolve, reject) => {
            const transaction = db.transaction(STORE, mode)
            let result: R
            transaction.oncomplete = () => resolve(result)
            transaction.onerror = () => reject(transaction.error)
            transaction.onabort = () => reject(transaction.error)
            body(transaction.objectStore(STORE), value => { result = value })
        })
    }
}
