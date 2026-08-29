import type { Observable } from "rxjs";
import type { DataChangeEvent, LivequeryAction, Doc, LivequeryPaging, LivequeryQueryParams, LivequeryResult } from "./types.js";


export type LivequeryQueryResult = {
    error: { code: string, message: string }
    changes: DataChangeEvent[]
    summary: Record<string, any>
    paging: LivequeryPaging
    metadata: Record<string, any>
    source: 'query' | 'action' | 'realtime'
    loading?: 'all' | 'next' | 'prev' | null
}



export type LivequeryTransporter = {
    query<T extends Doc>(query: LivequeryQueryParams<T>): Observable<Partial<LivequeryQueryResult>>
    add<T extends Doc>(ref: string, doc: Omit<T, 'id'>, context?: Record<string, any>): Promise<T>
    update<T extends Doc>(ref: string, id: string, doc: Partial<T>, context?: Record<string, any>): Promise<T>
    delete<T extends Doc>(ref: string, id: string, context?: Record<string, any>): Promise<T>
    trigger<T>(action: LivequeryAction): Promise<T>
}
