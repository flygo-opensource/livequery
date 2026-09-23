import { getByPath } from './filterDocs.js'

export type Sorter = [string, 'asc' | 'desc']

/** The `field:sort` entries of a filter set, in order. */
export function sortersOf(filters: Record<string, any> | undefined): Sorter[] {
    return Object.entries(filters ?? {})
        .filter(([k]) => k.endsWith(':sort'))
        .map(([k, v]) => [k.slice(0, -5), v === 'asc' || v === 1 || v === '1' ? 'asc' : 'desc'] as Sorter)
}

/**
 * Order by the sorters, then by `id` so the order is total: equal sort values never swap between
 * two reads, which keyset paging relies on. `id` follows the last sorter's direction (newest first
 * by default, like the server).
 */
export function compareDocs(sorters: Sorter[]) {
    const tie: Sorter[] = [...sorters, ['id', sorters.at(-1)?.[1] ?? 'desc']]
    return (a: Record<string, any>, b: Record<string, any>) => {
        for (const [path, direction] of tie) {
            const va = getByPath(a, path) as any
            const vb = getByPath(b, path) as any
            if (va === vb) continue
            if (va == null) return direction === 'asc' ? -1 : 1
            if (vb == null) return direction === 'asc' ? 1 : -1
            const order = va < vb ? -1 : 1
            return direction === 'asc' ? order : -order
        }
        return 0
    }
}

/** Sort by the `field:sort` entries of a filter set, in order; nested dot paths are supported. */
export function sortDocs<T>(items: T[], sorters: Sorter[]): T[] {
    if (sorters.length === 0) return items
    return items.sort(compareDocs(sorters) as (a: T, b: T) => number)
}
