import { LivequeryRequest } from "@livequery/types";
import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor, Optional, UseInterceptors } from "@nestjs/common";
import { map } from "rxjs/operators";
import { PathHelper } from "./helpers/PathHelper.js";
import { LivequeryWebsocketSync } from "./LivequeryWebsocketSync.js";
import { hidePrivateFields } from "./helpers/hidePrivateFields.js";

export type RealtimeSubscription = {
    ref: string,
    client_id: string
    gateway_id: string
    listener_node_id: string

}



@Injectable()
export class LivequeryInterceptor implements NestInterceptor {

    constructor(
        @Optional() @Inject(LivequeryWebsocketSync) private LivequeryWebsocketSync: LivequeryWebsocketSync
    ) {
    }

    async intercept(context: ExecutionContext, next: CallHandler) {

        const req = context.switchToHttp().getRequest()


        const {
            ref,
            is_collection,
            collection_ref,
            doc_id,

        } = PathHelper.parseHttpRequestPath(req._parsedUrl.pathname)

        const {
            collection_ref: schema_collection_ref,
            ref: schema_ref
        } = PathHelper.parseHttpRequestPath(req.route.path)


        req.livequery = {
            ref,
            schema_ref,
            collection_ref,
            schema_collection_ref,
            is_collection,
            doc_id,
            options: req.query,
            keys: req.params,
            body: req.body,
            method: req.method.toLowerCase()
        } as LivequeryRequest

        // Allow realtime by default    
        const client_id = req.headers['x-lcid'] || req.headers.socket_id
        const gateway_id = req.headers['x-lgid'] || this.LivequeryWebsocketSync?.id
        const cursor = req.query[':after'] || req.query[':before'] || req.query[':around']
        const e = {
            client_id,
            gateway_id,
            ref: req.livequery.ref,
            listener_node_id: this.LivequeryWebsocketSync.id
        }
        req.method == 'GET' && gateway_id && client_id && !cursor ? this.LivequeryWebsocketSync?.listen([e]) : null

        return next.handle().pipe(
            map(response => {
                if (response.item) {
                    return {
                        data: {
                            ...response,
                            item: hidePrivateFields(response.item.toJSON ? response.item.toJSON() : response.item),
                        }
                    }
                }
                return {
                    data: response || {}
                }
            })
        )
    }
}


export const UseLivequeryInterceptor = () => UseInterceptors(LivequeryInterceptor)