import type { LivequeryRequest } from '@livequery/core'

export type D1RouteOptions = {
    table: string | ((req: LivequeryRequest) => string | Promise<string>)
    realtime?: boolean
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
