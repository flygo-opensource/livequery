import type { Observable } from "rxjs";
import type { DataChangeEvent, LivequeryAction, Doc, LivequeryPaging, LivequeryQueryParams, LivequeryResult } from "./types";


export type LivequeryQueryResult<T extends Doc> = {
    changes: DataChangeEvent<T>[]
    summary: Record<string, any>
    paging: LivequeryPaging
    metadata: Record<string, any>
    source: 'query' | 'action' | 'realtime'
}


export type LivequeryTransporter = {
    query<T extends Doc>(query: LivequeryQueryParams<T>): Observable<Partial<LivequeryQueryResult<T>>>
    add<T extends Doc>(ref: string, doc: Omit<T, 'id'>): Promise<LivequeryResult<T>>
    update<T extends Doc>(ref: string, id: string, doc: Partial<T>): Promise<LivequeryResult<T>>
    delete<T extends Doc>(ref: string, id: string): Promise<LivequeryResult<T>>
    trigger<T>(action: LivequeryAction): Observable<T> | Promise<T>
}
