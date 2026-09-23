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
    /**
     * The changes are a complete re-read after a reconnect: collections update the documents they
     * hold and drop the ones the result no longer contains.
     */
    refetch?: boolean
}



export type LivequeryTransporter = {
    query<T extends Doc>(query: LivequeryQueryParams<T>): Observable<Partial<LivequeryQueryResult>>
    add<T extends Doc>(ref: string, doc: Omit<T, 'id'>, context?: Record<string, any>): Promise<T>
    update<T extends Doc>(ref: string, id: string, doc: Partial<T>, context?: Record<string, any>): Promise<T>
    delete<T extends Doc>(ref: string, id: string, context?: Record<string, any>): Promise<T>
    trigger<T>(action: LivequeryAction): Promise<T>
    /**
     * Connection state, for transporters that hold a connection (a realtime socket). The client
     * retries queued writes when it turns `connected`, and refetches live queries on a REconnect —
     * realtime events sent while the connection was down are lost.
     */
    status$?: Observable<{ connected: boolean }>
}
