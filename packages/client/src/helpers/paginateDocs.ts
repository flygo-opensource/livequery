import type { LivequeryPaging } from '../types.js'
import { getByPath } from './filterDocs.js'
import { compareDocs, type Sorter } from './sortDocs.js'

type Page<T> = { documents: T[], paging: LivequeryPaging }

/** Where a cursor carries the document's index in the order, when known (for page counts). */
export const CURSOR_INDEX = '#'

// A cursor is the position of one document in the order: its sort values and id — and, from a
// storage, its index, so the next page can tell how many come before it without counting.
export function encodeCursor(doc: Record<string, any>, sorters: Sorter[], index?: number): string {
    const position = Object.fromEntries([
        ...sorters.map(([path]) => [path, getByPath(doc, path)]),
        ['id', doc.id],
        ...index === undefined ? [] : [[CURSOR_INDEX, index]],
    ])
    return btoa(unescape(encodeURIComponent(JSON.stringify(position))))
}

/** A cursor back into a document-shaped object: its sort values (at their dot paths) and id. */
export function decodeCursor(cursor: string): Record<string, any> | null {
    try {
        const position = JSON.parse(decodeURIComponent(escape(atob(cursor))))
        if (!position || typeof position !== 'object') return null
        // Rebuild a document-shaped object so dot paths resolve the same way.
        const doc: Record<string, any> = {}
        for (const [path, value] of Object.entries(position)) {
            const keys = path.split('.')
            let target = doc
            for (const key of keys.slice(0, -1)) target = target[key] ??= {}
            target[keys.at(-1)!] = value
        }
        return doc
    } catch {
        return null
    }
}

/**
 * Keyset paging over documents already filtered and sorted with `compareDocs(sorters)`:
 * `:limit` is the page size, `:after` / `:before` a cursor from a previous page's
 * `paging.next` / `paging.prev`. A document inserted before the cursor never shifts the next page,
 * unlike an offset.
 *
 * Without `:limit` every document is returned, as before.
 */
export function paginateDocs<T extends { id: string }>(sorted: T[], sorters: Sorter[], filters: Record<string, any> = {}): Page<T> {
    const total = sorted.length
    const limit = Number(filters[':limit'])
    if (!Number.isFinite(limit) || limit <= 0) {
        return { documents: sorted, paging: { total, current: total } }
    }
    const compare = compareDocs(sorters)
    const after = typeof filters[':after'] === 'string' ? decodeCursor(filters[':after']) : null
    const before = typeof filters[':before'] === 'string' ? decodeCursor(filters[':before']) : null

    let start = 0
    let end = total
    if (after) {
        const index = sorted.findIndex(doc => compare(doc, after) > 0)
        start = index === -1 ? total : index
    }
    if (before) {
        const index = sorted.findIndex(doc => compare(doc, before) >= 0)
        end = index === -1 ? total : index
    }

    // Going backwards (`:before` alone) takes the page closest to the cursor.
    const documents = before && !after
        ? sorted.slice(Math.max(start, end - limit), end)
        : sorted.slice(start, Math.min(end, start + limit))
    const first = documents[0]
    const last = documents.at(-1)
    const first_index = first ? sorted.indexOf(first) : start
    const last_index = last ? sorted.indexOf(last) : start - 1
    const next_count = total - last_index - 1
    const prev_count = first_index

    return {
        documents,
        paging: {
            total,
            current: documents.length,
            ...last && next_count > 0 ? { next: { count: next_count, cursor: encodeCursor(last, sorters, last_index) } } : {},
            ...first && prev_count > 0 ? { prev: { count: prev_count, cursor: encodeCursor(first, sorters, first_index) } } : {},
        },
    }
}
