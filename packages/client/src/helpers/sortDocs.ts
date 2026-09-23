import { getByPath } from './filterDocs.js'

export type Sorter = [string, 'asc' | 'desc']

/** The `field:sort` entries of a filter set, in order. */
export function sortersOf(filters: Record<string, any> | undefined): Sorter[] {
    return Object.entries(filters ?? {})
        .filter(([k]) => k.endsWith(':sort'))
        .map(([k, v]) => [k.slice(0, -5), v === 'asc' || v === 1 || v === '1' ? 'asc' : 'desc'] as Sorter)
}

// MongoDB's order across types (BSON): null and missing, numbers, strings, objects, arrays,
// binary data (a UUID id), ObjectId, booleans. A local page must order documents exactly like the
// server, or a window of "the newest N" holds different documents than the server's cursor skips.
export const TYPE_RANK = { empty_array: 0, null: 1, number: 2, string: 3, object: 4, array: 5, uuid: 6, object_id: 7, boolean: 8 } as const

export function rankOf(value: unknown): number {
    if (value === null || value === undefined) return TYPE_RANK.null
    if (typeof value === 'number') return TYPE_RANK.number
    if (typeof value === 'string') return TYPE_RANK.string
    if (typeof value === 'boolean') return TYPE_RANK.boolean
    if (Array.isArray(value)) return TYPE_RANK.array
    return TYPE_RANK.object
}

/** Strings as MongoDB compares them: by code point (UTF-8 byte order), not by UTF-16 unit. */
export function compareStrings(a: string, b: string): number {
    if (a === b) return 0
    const x = a[Symbol.iterator]()
    const y = b[Symbol.iterator]()
    for (;;) {
        const i = x.next()
        const j = y.next()
        if (i.done || j.done) return i.done && j.done ? 0 : i.done ? -1 : 1
        const d = i.value.codePointAt(0)! - j.value.codePointAt(0)!
        if (d !== 0) return d < 0 ? -1 : 1
    }
}

/** Two values in BSON order; arrays and objects element by element, like MongoDB. */
export function compareValues(a: unknown, b: unknown): number {
    const ra = rankOf(a)
    const rb = rankOf(b)
    if (ra !== rb) return ra < rb ? -1 : 1
    switch (ra) {
        case TYPE_RANK.null: return 0
        case TYPE_RANK.number: return (a as number) === (b as number) ? 0 : (a as number) < (b as number) ? -1 : 1
        case TYPE_RANK.string: return compareStrings(a as string, b as string)
        case TYPE_RANK.boolean: return a === b ? 0 : a ? 1 : -1
        case TYPE_RANK.array: {
            const x = a as unknown[]
            const y = b as unknown[]
            for (let i = 0; i < Math.min(x.length, y.length); i++) {
                const d = compareValues(x[i], y[i])
                if (d !== 0) return d
            }
            return x.length === y.length ? 0 : x.length < y.length ? -1 : 1
        }
        default: {
            const x = Object.entries(a as object)
            const y = Object.entries(b as object)
            for (let i = 0; i < Math.min(x.length, y.length); i++) {
                // MongoDB: the value's type, then the field name, then the value.
                const [kx, vx] = x[i]!
                const [ky, vy] = y[i]!
                const d = Math.sign(rankOf(vx) - rankOf(vy)) || compareStrings(kx, ky) || compareValues(vx, vy)
                if (d !== 0) return d
            }
            return x.length === y.length ? 0 : x.length < y.length ? -1 : 1
        }
    }
}

// A sort field holding an array sorts by its smallest element ascending, its largest descending;
// an empty array comes before null.
function sortValue(value: unknown, direction: 'asc' | 'desc'): unknown {
    if (!Array.isArray(value)) return value
    if (value.length === 0) return EMPTY
    return value.reduce((best, item) => {
        const d = compareValues(item, best)
        return direction === 'asc' ? (d < 0 ? item : best) : (d > 0 ? item : best)
    })
}
const EMPTY = Symbol('empty array')

const OBJECT_ID = /^[0-9a-f]{24}$/i
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Where an id sorts on MongoDB: a client-chosen UUID is stored as binary data, before any ObjectId
 * (24 hex); each kind in byte order, which is the order of its lowercase hex. Other ids are strings.
 */
export function idRank(id: string): [number, string] {
    if (UUID.test(id)) return [TYPE_RANK.uuid, id.toLowerCase()]
    if (OBJECT_ID.test(id)) return [TYPE_RANK.object_id, id.toLowerCase()]
    return [TYPE_RANK.string, id]
}

function compareIds(a: unknown, b: unknown): number {
    if (typeof a !== 'string' || typeof b !== 'string') return compareValues(a, b)
    const [ra, va] = idRank(a)
    const [rb, vb] = idRank(b)
    return ra !== rb ? (ra < rb ? -1 : 1) : compareStrings(va, vb)
}

/**
 * Order by the sorters, then by `id` so the order is total: equal sort values never swap between
 * two reads, which keyset paging relies on. `id` follows the last sorter's direction (newest first
 * by default, like the server). Values compare as MongoDB compares them (`compareValues`).
 */
export function compareDocs(sorters: Sorter[]) {
    const tie: Sorter[] = [...sorters, ['id', sorters.at(-1)?.[1] ?? 'desc']]
    return (a: Record<string, any>, b: Record<string, any>) => {
        for (const [path, direction] of tie) {
            let order: number
            if (path === 'id') {
                order = compareIds(a.id, b.id)
            } else {
                const va = sortValue(getByPath(a, path), direction)
                const vb = sortValue(getByPath(b, path), direction)
                order = va === EMPTY || vb === EMPTY
                    ? (va === vb ? 0 : va === EMPTY ? -1 : 1)
                    : compareValues(va, vb)
            }
            if (order !== 0) return direction === 'asc' ? order : -order
        }
        return 0
    }
}

/** Sort by the `field:sort` entries of a filter set, in order; nested dot paths are supported. */
export function sortDocs<T>(items: T[], sorters: Sorter[]): T[] {
    if (sorters.length === 0) return items
    return items.sort(compareDocs(sorters) as (a: T, b: T) => number)
}
