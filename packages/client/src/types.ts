export type Doc<T = {}> = T & {
    id: string
}

export type DocState<T extends Doc> = T & {
    _deleting?: boolean
    _updating?: boolean
    _adding?: boolean
    _remotes?: Record<string, string | number>
    _prev?: Partial<T>
}

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
    QueryBuilder<T, number, 'gt', number> &
    QueryBuilder<T, number, 'gte', number> &
    QueryBuilder<T, number, 'lt', number> &
    QueryBuilder<T, number, 'lte', number> &
    QueryBuilder<T, number, 'eq-number', number> &
    QueryBuilder<T, number, 'in', number[]> &
    QueryBuilder<T, number, 'nin', number[]> &
    QueryBuilder<T, number[], 'include', number> &
    QueryBuilder<T, boolean, 'boolean', 'true' | 'false' | 'not-true' | 'not-false'> &
    QueryBuilder<T, string, 'like', string> &
    QueryBuilder<T, string, 'in', string[]> &
    QueryBuilder<T, string, 'nin', string[]> &
    QueryBuilder<T, string[], 'include', string> &
    QueryBuilder<T, any, 'null', 'null-only' | 'not-null'>
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
}


export type LivequeryAction = Omit<LivequeryQueryParams<Doc>, 'query_id' | 'filters'> & {
    action: string
    payload?: Record<string, any>
}

export type LivequeryResult<T> = {
    data: T
    error?: { code: string, message: string }
}