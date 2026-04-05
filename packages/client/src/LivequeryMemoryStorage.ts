import type { LivequeryDocument, LivequeryPaging } from "./types"
import type { LivequeryStorge } from "./LivequeryStorge"
import { filterLivequeryDocuments } from "./helpers/filterLivequeryDocuments"



export class LivequeryMemoryStorage implements LivequeryStorge {
    #collections = new Map<string, LivequeryDocument[]>()

    async query<T extends LivequeryDocument>(collection: string, filters?: Record<string, any>): Promise<{
        documents: T[]
        paging: LivequeryPaging
    }> {
        const sources = (this.#collections.get(collection) || []) as T[]
        const f = filters || {}
        const sorters = Object.entries(f).filter(([k]) => k.endsWith(":sort")) as Array<[string, "asc" | "desc"]>
        const items = filterLivequeryDocuments(sources, f)
        const sorted = this.#sortItems(items, sorters)
        return {
            documents: sorted,
            paging: {
                total: items.length,
                current: sorted.length
            }
        }
    }

    get<T extends LivequeryDocument>(ref: string, id: string): Promise<T | null> {
        const docs = this.#collections.get(ref) as T[] | undefined
        if (!docs) return Promise.resolve(null)
        const doc = docs.find((d) => d.id === id) || null
        return Promise.resolve(doc)
    }

    async add<T extends LivequeryDocument>(collection: string, document: T): Promise<T> {
        const docs = this.#clone(collection) as T[]
        const doc = {
            ...document,
            id: document.id || `local:${crypto.randomUUID()}`
        }
        if (!document.id) {
            docs.push(doc)
        } else {
            const index = docs.findIndex((doc) => doc.id === document.id)
            if (index >= 0) {
                docs[index] = document
            } else {
                docs.push(document)
            }
        }
        this.#collections.set(collection, docs)
        return doc
    }

    async update<T extends LivequeryDocument>(collection: string, id: string, document: Record<string, any>): Promise<T | null> {
        const docs = this.#clone(collection) as T[]
        const index = docs.findIndex((doc) => doc.id === id)
        if (index < 0) return null
        const next = {
            ...docs[index],
            ...document,
            id,
        } as T
        docs[index] = next
        this.#collections.set(collection, docs)
        return next
    }

    async delete<T extends LivequeryDocument>(collection: string, id: string): Promise<T | null> {
        const docs = this.#clone(collection) as T[]
        const index = docs.findIndex((doc) => doc.id === id)
        if (index < 0) return null
        const [deleted] = docs.splice(index, 1)
        this.#collections.set(collection, docs)
        return (deleted || null) as T | null
    }

    clear(collection?: string) {
        if (collection) {
            this.#collections.delete(collection)
            return
        }
        this.#collections.clear()
    }

    seed<T extends LivequeryDocument>(collection: string, docs: T[]) {
        this.#collections.set(collection, [...docs])
    }

    #clone(collection: string) {
        const current = this.#collections.get(collection) || []
        return [...current]
    }

    #sortItems<T extends LivequeryDocument>(
        items: T[],
        sorters: Array<[string, 'asc' | 'desc']>
    ): T[] {
        if (sorters.length === 0) return items
        const copied = [...items]
        copied.sort((a, b) => {
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
        return copied
    }


    #getByPath(obj: Record<string, any>, path: string) {
        if (!path.includes('.')) return obj[path]
        return path.split('.').reduce<unknown>((acc, key) => {
            if (!acc || typeof acc !== 'object') return undefined
            return (acc as Record<string, any>)[key]
        }, obj)
    }
}