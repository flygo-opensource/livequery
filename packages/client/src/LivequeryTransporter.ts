import type { Observable } from "rxjs";
import type { LivequeryAction, LivequeryDocument, LivequeryQueryParams } from "./types";



export type DataChangeEvent<T extends LivequeryDocument> = {
    id: string
    type: 'added' | 'removed' | 'updated'
    source: 'query' | 'action' | 'realtime'
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
    query<T extends LivequeryDocument>(query: LivequeryQueryParams<T>): Observable<Partial<LivequeryQueryResult<T>>>
    trigger<T extends LivequeryDocument>(action: LivequeryAction<T>): Observable<T>
}
