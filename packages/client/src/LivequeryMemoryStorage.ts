import type { Doc, LivequeryPaging, ParitalDocState } from "./types.js"
import type { LivequeryStorage } from "./LivequeryStorage.js"
import { queryDocs } from "./helpers/queryDocs.js"
import { uuidv7 } from "uuidv7"



export class LivequeryMemoryStorage implements LivequeryStorage {
    #collections = new Map<string, Map<string, Doc>>()

    async query<T extends Doc>(collection: string, filters?: Record<string, any>): Promise<{
        documents: T[]
        paging: LivequeryPaging
    }> {
        const sources = Array.from((this.#collections.get(collection) || new Map<string, Doc>()).values()) as T[]
        return queryDocs(sources, filters)
    }

    get<T extends Doc>(ref: string, id: string): Promise<T | null> {
        const docs = this.#collections.get(ref)
        if (!docs) return Promise.resolve(null)
        const doc = (docs.get(id) as T) || null
        return Promise.resolve(doc)
    }

    async add<T extends Doc>(collection: string, document: ParitalDocState<T>){
        const docs = this.#collections.get(collection) || new Map<string, Doc>()
        const doc = {
            ...document,
            id: document.id || `local:${uuidv7()}`
        } as T
        docs.set(doc.id, doc)
        this.#collections.set(collection, docs)
        return doc
    }

    async update<T extends Doc>(collection: string, id: string, document: Record<string, any>): Promise<T | null> {
        const docs = this.#collections.get(collection)
        if (!docs) return null
        const existing = docs.get(id)
        if (!existing) return null
        const next = {
            ...existing,
            ...document,
        } as T
        if (document.id && document.id !== id) {
            docs.delete(id)
            docs.set(document.id, next)
        } else {
            docs.set(id, next)
        }
        return next
    }

    async delete<T extends Doc>(collection: string, id: string): Promise<T | null> {
        const docs = this.#collections.get(collection)
        if (!docs) return null
        const deleted = docs.get(id) as T || null
        docs.delete(id)
        return deleted
    }

    flush(): Promise<void> {
        this.#collections.clear()
        return Promise.resolve()
    }
}
