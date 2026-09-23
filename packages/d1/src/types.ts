import type { LivequeryRequest } from '@livequery/core'

export type D1DatasourceConfig = {
    databases: Record<string, D1Database>
}

export type D1RouteOptions = {
    table: string | ((req: LivequeryRequest) => string | Promise<string>)
    database?: string | ((req: LivequeryRequest) => string | Promise<string>)
    realtime?: boolean
    /**
     * Columns a client may filter, sort or write. `id` and route keys are always allowed.
     * Leave unset only when every column of the table is safe to expose.
     */
    fields?: readonly string[]
    /**
     * Accept the id a client sends on add (a uuidv7), so a retried add cannot create a second
     * row: the retry reuses the id and the primary key rejects it (409 ID_ALREADY_EXISTS).
     * Default true; false ignores it and assigns a random id, as before 3.0.
     */
    clientIds?: boolean
}

export type QueryPlan = {
    itemsSql: string
    itemsParams: unknown[]
    prevCountSql: string
    prevCountParams: unknown[]
    nextCountSql: string
    nextCountParams: unknown[]
    limit: number
    reverseItems: boolean
}

export type D1CollectionResult<T> = {
    items: T[]
    cursor: { first: string | null; last: string | null }
    has: { prev: boolean; next: boolean }
    count: { prev: number; next: number; current: number; total: number }
    page: { current: number; total: number }
}

export type D1DocumentResult<T> = {
    item: T | null
}
