import type { Observable } from "rxjs";
import type { DataChangeEvent, LivequeryAction, Doc, LivequeryPaging, LivequeryQueryParams } from "./types";


export type LivequeryQueryResult<T extends Doc> = {
    query_id: string
    changes: DataChangeEvent<T>[]
    summary: Record<string, any>
    paging: LivequeryPaging
    metadata: Record<string, any>
    source: 'query' | 'action' | 'realtime'
}


export type LivequeryTransporter = { 
    query<T extends Doc>(query: LivequeryQueryParams<T>): Observable<Partial<LivequeryQueryResult<T>>>
    trigger<T>(action: LivequeryAction): Observable<{ data: T, error?: Error }>
}
