import type { Doc, LivequeryPaging } from "./types"
import type { LivequeryStorge } from "./LivequeryStorge"
import { filterDocs } from "./helpers/filterDocs"



export class LivequeryMemoryStorage implements LivequeryStorge {
    #collections = new Map<string, Map<string, Doc>>()

    async query<T extends Doc>(collection: string, filters?: Record<string, any>): Promise<{
        documents: T[]
        paging: LivequeryPaging
    }> {
        const sources = Array.from((this.#collections.get(collection) || new Map<string, Doc>()).values()) as T[]
        const f = filters || {}
        const sorters = Object.entries(f).filter(([k]) => k.endsWith(":sort")) as Array<[string, "asc" | "desc"]>
        const items = filterDocs(sources, f)
        const sorted = this.#sortItems(items, sorters)
        return {
            documents: sorted,
            paging: {
                total: items.length,
                current: sorted.length
            }
        }
    }

    get<T extends Doc>(ref: string, id: string): Promise<T | null> {
        const docs = this.#collections.get(ref)
        if (!docs) return Promise.resolve(null)
        const doc = (docs.get(id) as T) || null
        return Promise.resolve(doc)
    }

    async add<T extends Doc>(collection: string, document: T): Promise<T> {
        const docs = this.#collections.get(collection) || new Map<string, Doc>()
        const doc = {
            ...document,
            id: document.id || `local:${crypto.randomUUID()}`
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


    #sortItems<T extends Doc>(
        items: T[],
        sorters: Array<[string, 'asc' | 'desc']>
    ): T[] {
        if (sorters.length === 0) return [...items]
        return [...items].sort((a, b) => {
            for (const [sortKey, direction] of sorters) {
                const fieldPath = sortKey.slice(0, -5)
                const va = this.#getByPath(a, fieldPath)
                const vb = this.#getByPath(b, fieldPath)
                if (va === vb) continue
                const order = va! < vb! ? -1 : 1
                return direction === 'asc' ? order : -order
            }
            return 0
        })
    }


    #getByPath(obj: Record<string, any>, path: string) {
        if (!path.includes('.')) return obj[path]
        return path.split('.').reduce<unknown>((acc, key) => {
            if (!acc || typeof acc !== 'object') return undefined
            return (acc as Record<string, any>)[key]
        }, obj)
    }
}