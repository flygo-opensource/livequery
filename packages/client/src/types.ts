export type LivequeryDocument = {
    id: string
    [key: string]: any
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


type QueryBuilder<T extends LivequeryDocument, FieldType, PostFix extends string | number, Value> = {
    [K in keyof T as `${FlatObjectKeys<T, FieldType>}${PostFix extends string ? `:${PostFix}` : ''}`]?: Value
}

export type LivequeryPagingFilters<T extends LivequeryDocument> = (
    QueryBuilder<T, string, 'sort', 'asc' | 'desc'>
) & {
    ':limit': number
    ':before': string
    ':after': string
    ':page': number
}

export type LivequeryFilters<T extends LivequeryDocument> = (
    // QueryBuilder<T, string, 0, string> &
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




export type DataChangeEvent<T extends LivequeryDocument> = {
    id: string
    type: 'added' | 'removed' | 'updated'
    data: Partial<Omit<T, 'id'>>
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



export type LivequeryQueryParams<T extends LivequeryDocument> = {
    ref: string
    query_id: string
    filters?: Partial<LivequeryFilters<T>>
    headers?: Record<string, string>
    collection_id: string
}


export type LivequeryActionType = 'add' | 'update' | 'delete' | `~${string}`


export type LivequeryAction<T extends LivequeryDocument> = Omit<LivequeryQueryParams<T>, 'query_id'> & {
    action: LivequeryActionType
    payload?: Record<string, any>
}
