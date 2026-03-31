import type { LivequeryDocument, LivequeryPaging } from "./types"
import type { LivequeryStorge } from "./LivequeryStorge"
import { filterLivequeryDocuments } from "./helpers/filterLivequeryDocuments"

type CursorFilters = {
    ':limit'?: number
    ':page'?: number
    ':after'?: string
    ':before'?: string
}

export class LivequeryMemoryStorage implements LivequeryStorge {
    #collections = new Map<string, LivequeryDocument[]>()

    async query<T extends LivequeryDocument>(collection: string, filters?: Record<string, any>): Promise<{
        documents: T[]
        paging: LivequeryPaging
    }> {
        const sources = (this.#collections.get(collection) || []) as T[]
        const f = filters || {}
        const sorters = Object.entries(f).filter(([k]) => k.endsWith(":sort")) as Array<[string, "asc" | "desc"]>
        const cursor: CursorFilters = {
            ':limit': this.#toNumber(f[':limit']),
            ':page': this.#toNumber(f[':page']),
            ':after': typeof f[':after'] === 'string' ? f[':after'] : undefined,
            ':before': typeof f[':before'] === 'string' ? f[':before'] : undefined,
        }

        const items = filterLivequeryDocuments(sources, f)
        const sorted = this.#sortItems(items, sorters)
        return this.#applyCursor(sorted, cursor)
    }

    async add<T extends LivequeryDocument>(collection: string, document: T): Promise<T> {
        const docs = this.#clone(collection) as T[]
        const index = docs.findIndex((doc) => doc.id === document.id)
        if (index >= 0) docs[index] = document
        else docs.push(document)
        this.#collections.set(collection, docs)
        return document
    }

    async update<T extends LivequeryDocument>(collection: string, id: string, document: Partial<T>): Promise<T | null> {
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

    #applyCursor<T extends LivequeryDocument>(items: T[], cursor: CursorFilters): {
        documents: T[]
        paging: LivequeryPaging
    } {
        let output = items

        if (cursor[':after']) {
            const index = output.findIndex((item) => item.id === cursor[':after'])
            if (index >= 0) output = output.slice(index + 1)
        }

        if (cursor[':before']) {
            const index = output.findIndex((item) => item.id === cursor[':before'])
            if (index >= 0) output = output.slice(0, index)
        }

        const limit = cursor[':limit']
        if (!limit || limit <= 0) {
            return {
                documents: output,
                paging: {
                    total: output.length,
                    current: 1,
                }
            }
        }

        const page = cursor[':page'] && cursor[':page'] > 0 ? cursor[':page'] : 1
        const start = (page - 1) * limit
        const documents = output.slice(start, start + limit)

        const hasPrev = start > 0 && documents.length > 0
        const hasNext = (start + documents.length) < output.length && documents.length > 0

        return {
            documents,
            paging: {
                total: output.length,
                current: page,
                ...(hasPrev ? {
                    prev: {
                        cursor: documents[0]!.id,
                        count: start,
                    }
                } : {}),
                ...(hasNext ? {
                    next: {
                        cursor: documents[documents.length - 1]!.id,
                        count: output.length - (start + documents.length),
                    }
                } : {}),
            }
        }
    }

    #getByPath(obj: Record<string, any>, path: string) {
        if (!path.includes('.')) return obj[path]
        return path.split('.').reduce<unknown>((acc, key) => {
            if (!acc || typeof acc !== 'object') return undefined
            return (acc as Record<string, any>)[key]
        }, obj)
    }

    #toNumber(value: unknown) {
        const n = Number(value)
        return Number.isFinite(n) ? n : undefined
    }
}