import type { Observable } from "rxjs";
import type { DataChangeEvent, LivequeryAction, LivequeryDocument, LivequeryPaging, LivequeryQueryParams } from "./types";



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
