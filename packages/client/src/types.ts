export type LivequeryDocument = {
    id: string
    [key: string]: any
}

export type LivequeryActionType = 'add' | 'update' | 'delete' | `~${string}`

type FlatObjectKeys<T, MatchType, K extends keyof T = keyof T> = (
    K extends string ? (
        T[K] extends MatchType ? K : (
            T[K] extends { [key: string]: any } ? (
                `${K}.${FlatObjectKeys<T[K], MatchType>}`
            ) : never
        )
    ) : never
)


type QueryBuilder<T extends LivequeryDocument, FieldType, PostFix extends string | null, Value> = {
    [K in keyof T as `${FlatObjectKeys<T, FieldType>}${PostFix extends string ? `:${PostFix}` : ''}`]?: Value
}


export type LivequeryFilters<T extends LivequeryDocument> = (
    QueryBuilder<T, string, null, string> &
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


export type LivequeryQueryParams<T extends LivequeryDocument> = {
    ref: string
    filters?: LivequeryFilters<T>
    headers?: Record<string, string>
}




export type LivequeryAction<T extends LivequeryDocument> = LivequeryQueryParams<T> & {
    action: 'get' | 'post' | 'patch' | `~${string}`
    payload?: Record<string, any>
}
