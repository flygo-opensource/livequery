import type { LivequeryPaging } from '../types.js'
import { filterDocs } from './filterDocs.js'
import { paginateDocs } from './paginateDocs.js'
import { compareDocs, sortersOf } from './sortDocs.js'

/**
 * What every storage's `query()` answers for one collection: filter, sort (with an `id`
 * tie-break), then keyset paging (`:limit`, `:after`, `:before`). One implementation, so every
 * adapter pages identically.
 */
export function queryDocs<T extends { id: string }>(sources: T[], filters: Record<string, any> = {}): { documents: T[], paging: LivequeryPaging } {
    const sorters = sortersOf(filters)
    const matching = filterDocs(sources, filters)
    const sorted = sorters.length > 0 || filters[':limit'] != null ? matching.sort(compareDocs(sorters)) : matching
    const page = paginateDocs(sorted, sorters, filters)
    // `total` is how many documents match, so a UI can say "30 of 250".
    return { documents: page.documents, paging: { ...page.paging, total: matching.length } }
}
