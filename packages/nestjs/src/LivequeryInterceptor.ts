import { LivequeryRequest } from "@livequery/types";
import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor, Optional, UseInterceptors } from "@nestjs/common";
import { map } from "rxjs/operators";
import { PathHelper } from "./helpers/PathHelper.js";
import { LivequeryWebsocketSync } from "./LivequeryWebsocketSync.js";
import { InjectWebsocketPrivateKey } from "./UseWebsocketShareKeyPair.js";
import JWT from 'jsonwebtoken'

export type RealtimeSubscription = {
    session_id: string
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
        const session_id = req.headers.session_id || req.headers.socket_id
        req.method == 'GET' && session_id && this.LivequeryWebsocketSync?.listen(
            {
                collection_ref,
                doc_id,
                session_id
            })

        const realtime_token = await new Promise(s => {
            if (!this.secret_or_private_key || req.method.toLowerCase() != 'get') return s(null)
            JWT.sign({ collection_ref, doc_id, session_id } as RealtimeSubscription, this.secret_or_private_key, {}, (error, data) => s(error ? null : data))
        })
        return next.handle().pipe(
            map(data => {
                if (data.item && !data.item.id) {
                    data.item.id = data.item._id?.toString()
                }
                return {
                    data: {
                        ...data,
                        realtime_token
                    }
                }
            })
        )
    }
}


export const UseLivequeryInterceptor = () => UseInterceptors(LivequeryInterceptor)