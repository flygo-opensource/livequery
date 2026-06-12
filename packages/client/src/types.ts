export type Doc<T = {}> = T & {
    id: string
}

export type DocError = { code: string, message: string, transporter_id: string }

export type DocMetadata = {
    _deleting?: boolean | undefined
    _local_only?: boolean | undefined
    _deleting_error?: DocError | undefined
    _updating?: boolean | undefined
    _updating_error?: DocError | undefined
    _adding?: boolean | undefined
    _adding_error?: DocError | undefined
    _remotes?: Record<string, string | number> | undefined
    _prev?: Record<string, any> | undefined
    _selected?: boolean | undefined
    _index?: number | undefined
}

export type DocState<T extends Doc> = T & DocMetadata

export type ParitalDocState<T extends Doc> = { id: string } & Partial<T> & Partial<DocMetadata>


export type RealtimeChangeSource = 'realtime' | 'action' | 'query'

type FlatObjectKeys<T, MatchType, K extends keyof T = keyof T> = (
    K extends string ? (
        0 extends (1 & T[K]) ? never : (
            // T[K] extends unknown ? never : (
            T[K] extends MatchType ? K : (
                T[K] extends { [key: string]: any } ? (
                    `${K}.${FlatObjectKeys<T[K], MatchType>}`
                ) : never
            )
            // )
        )
    ) : never
)


type QueryBuilder<T extends Doc, FieldType, PostFix extends string | number, Value> = {
    [K in keyof T as `${FlatObjectKeys<T, FieldType>}${PostFix extends string ? `:${PostFix}` : ''}`]?: Value
}

export type LivequeryPagingFilters = {
    ':limit': number
    ':before': string
    ':after': string
    ':around': string
    ':page': number
}

export type LivequeryInlineFilters<T extends Doc> = (
    QueryBuilder<T, number, 'sort', 'asc' | 'desc'> &
    QueryBuilder<T, string, 'sort', 'asc' | 'desc'> &
    QueryBuilder<T, boolean, 'sort', 'asc' | 'desc'> &
    QueryBuilder<T, any, 1, any> &
    QueryBuilder<T, number, 'gt', number> &
    QueryBuilder<T, number, 'gte', number> &
    QueryBuilder<T, number, 'lt', number> &
    QueryBuilder<T, number, 'lte', number> &
    QueryBuilder<T, number, 'eq-number', number> &
    QueryBuilder<T, number, 'neq-number', number> &
    QueryBuilder<T, number, 'in', string | number[]> &
    QueryBuilder<T, number, 'nin', string | number[]> &
    QueryBuilder<T, any, 'ne', any> &
    QueryBuilder<T, boolean, 'eq-boolean', boolean | 'true' | 'false'> &
    QueryBuilder<T, boolean, 'neq-boolean', boolean | 'true' | 'false'> &
    QueryBuilder<T, any, 'eq-null', null | true | 'true'> &
    QueryBuilder<T, any, 'neq-null', null | true | 'true'> &
    QueryBuilder<T, string, 'eq-oid', string> &
    QueryBuilder<T, string, 'neq-oid', string> &
    QueryBuilder<T, string, 'like', string> &
    QueryBuilder<T, string, 'in', string | string[]> &
    QueryBuilder<T, string, 'nin', string | string[]>
)


export type LivequeryFilters<T extends Doc> = LivequeryPagingFilters & LivequeryInlineFilters<T>

export type DataChangeEvent = {
    collection_ref: string
    id: string
    type: 'added' | 'removed' | 'modified'
    data?: Record<string, any>
}



export type LivequeryPaging = {
    next?: {
        count: number
        cursor: string
    }
    prev?: {
        count: number
        cursor: string
    }
    total: number
    current: number
}



export type LivequeryQueryParams<T extends Doc> = {
    ref: string
    filters?: Partial<LivequeryFilters<T>>
    headers?: Record<string, string>
    // Arbitrary per-collection context forwarded to the transporter's onRequest hook
    // (e.g. { account_id } for multi-account routing). Not sent to the server by default —
    // onRequest decides what to do with it.
    context?: Record<string, any>
}


export type LivequeryAction = Omit<LivequeryQueryParams<Doc>, 'query_id' | 'filters'> & {
    action: string
    payload?: Record<string, any>
    transporter_id?: string
}

export type LivequeryResult<T> = {
    data: T
    error?: { code: string, message: string }
}
