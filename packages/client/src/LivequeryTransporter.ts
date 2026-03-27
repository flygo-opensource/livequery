import type { Observable } from "rxjs";


export type LivequeryDocument = {
    id: string
    [key: string]: any
}

export type LivequeryActionType = 'add' | 'update' | 'delete' | `~${string}`

export type LivequeryQuery = {
    ref: string
    query?: Record<string, any>
    headers?: Record<string, any>
}


export type LivequeryAction = LivequeryQuery & {
    action: LivequeryActionType
    payload?: Record<string, any>
}



export type DataChangeEvent<T extends LivequeryDocument> = {
    id: string
    type: 'added' | 'removed' | 'updated'
    source: 'query'|'action'|'realtime'
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


export type LivequeryQueryResult<T extends LivequeryDocument> = {
    changes: DataChangeEvent<T>[]
    summary: Record<string, any>
    paging: LivequeryPaging
    metadata: Record<string, any>
}


export type LivequeryTransporter = {
    query<T extends LivequeryDocument>(query: LivequeryQuery): Observable<Partial<LivequeryQueryResult<T>>>
    trigger<T>(action: LivequeryAction): Observable<T>
}
