import { applyDecorators, SetMetadata, UseInterceptors } from "@nestjs/common";
import { LivequeryDatasourceInterceptors } from "../LivequeryDatasourceInterceptors.js";
import { UseLivequeryInterceptor } from "../LivequeryInterceptor.js";
import { LivequeryRequest, WebsocketSyncPayload } from "@livequery/types";
import { Subject } from "rxjs/internal/Subject";

export type DatatasourceConnectionMetadata = {
    connection: string | symbol | (
        (req: LivequeryRequest) => symbol | string | Promise<symbol | string>
    )
}

export type LivequeryDatasource<T> = Subject<WebsocketSyncPayload<any>> & {
    query(query: LivequeryRequest, options: T, connection: any): any
}


export const createDatasourceMapper = <A>(
    factory: { new(...args: any[]): LivequeryDatasource<A> },
    defaultOptions: Partial<A> & DatatasourceConnectionMetadata
) => (options: A) => applyDecorators(
    UseLivequeryInterceptor(),
    UseInterceptors(LivequeryDatasourceInterceptors),
    SetMetadata(LivequeryDatasourceInterceptors, {
        factory,
        options: {
            ...defaultOptions,
            ...options
        }
    })
)