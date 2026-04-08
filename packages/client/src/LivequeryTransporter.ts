import type { Observable } from "rxjs";
import type { DataChangeEvent, LivequeryAction, Doc, LivequeryPaging, LivequeryQueryParams, LivequeryResult } from "./types";


export type LivequeryQueryResult = {
    changes: DataChangeEvent[]
    summary: Record<string, any>
    paging: LivequeryPaging
    metadata: Record<string, any>
    source: 'query' | 'action' | 'realtime'
}



export type LivequeryTransporter<Context> = {
    query<T extends Doc>( query: LivequeryQueryParams<T>): Observable<Partial<LivequeryQueryResult>>
    add<T extends Doc>( ref: string, doc: Omit<T, 'id'>): Promise<T>
    update<T extends Doc>( ref: string, id: string, doc: Partial<T>): Promise<T>
    delete<T extends Doc>( ref: string, id: string): Promise<T>
    trigger<T>( action: LivequeryAction): Promise<T>
}
