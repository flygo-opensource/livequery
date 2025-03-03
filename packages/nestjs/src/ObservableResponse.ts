import { LivequeryBaseEntity, WebsocketSyncPayload } from "@livequery/types";
import { Observable } from "rxjs";
import { LivequeryRequest } from "./LivequeryRequest.js";

export type ObservableResponseContext = {
    ref: string
    req: LivequeryRequest,
    on: { unsubcribe$: Observable<any> },
}

export type ObservableResponseOptions<T extends LivequeryBaseEntity> = {
    first?: any,
    autoStop?: boolean
    observable: Observable<WebsocketSyncPayload<T>>
}


export class ObservableResponse<T extends LivequeryBaseEntity> {
    constructor(public readonly handler: (ctx: ObservableResponseContext) => ObservableResponseOptions<T>) { }
}

