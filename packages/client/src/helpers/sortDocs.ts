import { getByPath } from './filterDocs.js'

/** Sort by the `field:sort` entries of a filter set, in order; nested dot paths are supported. */
export function sortDocs<T>(items: T[], sorters: Array<[string, 'asc' | 'desc']>): T[] {
    if (sorters.length === 0) return items
    return items.sort((a, b) => {
        for (const [sort_key, direction] of sorters) {
            const field_path = sort_key.slice(0, -5)
            const va = getByPath(a as any, field_path)
            const vb = getByPath(b as any, field_path)
            if (va === vb) continue
            const order = va! < vb! ? -1 : 1
            return direction === 'asc' ? order : -order
        }
        return 0
    })
}
