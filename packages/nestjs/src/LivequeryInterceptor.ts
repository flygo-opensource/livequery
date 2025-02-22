import { LivequeryRequest } from "@livequery/types";
import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor, Optional, UseInterceptors } from "@nestjs/common";
import { map } from "rxjs/operators";
import { PathHelper } from "./helpers/PathHelper.js";
import { LivequeryWebsocketSync } from "./LivequeryWebsocketSync.js";
import { InjectWebsocketPrivateKey } from "./UseWebsocketShareKeyPair.js";
import JWT from 'jsonwebtoken'
import { hidePrivateFields } from "./helpers/hidePrivateFields.js";

export type RealtimeSubscription = {
    client_id: string
    gateway_id: string
    collection_ref: string,
    doc_id: string
}

@Injectable()
export class LivequeryInterceptor implements NestInterceptor {

    constructor(
        @Optional() @Inject(LivequeryWebsocketSync) private LivequeryWebsocketSync: LivequeryWebsocketSync,
        @Optional() @InjectWebsocketPrivateKey() private secret_or_private_key: string
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
        const gateway_id = req.headers['x-lgid'] || this.LivequeryWebsocketSync.id
        req.method == 'GET' && client_id && this.LivequeryWebsocketSync?.listen([{
            collection_ref,
            doc_id,
            client_id,
            gateway_id
        }])
 
        return next.handle().pipe(
            map(data => {
                if (data.item) {
                    return {
                        data: {
                            ...data,
                            item: hidePrivateFields(data.item.toJSON ? data.item.toJSON() : data.item),
                        }
                    }
                }
                return {
                    data 
                }
            })
        )
    }
}


export const UseLivequeryInterceptor = () => UseInterceptors(LivequeryInterceptor)