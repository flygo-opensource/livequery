import { LivequeryRequest, QueryOption } from "@livequery/types";
import { CallHandler, ExecutionContext, forwardRef, Inject, Injectable, NestInterceptor, Optional, UseInterceptors } from "@nestjs/common";
import { map } from "rxjs/operators";
import { PathHelper } from "./helpers/PathHelper.js";
import { LivequeryWebsocketSync } from "./LivequeryWebsocketSync.js";
import { InjectWebsocketPrivateKey } from "./UseWebsocketShareKeyPair.js";
import JWT from 'jsonwebtoken'

export type RealtimeSubscription = {
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
        const { _limit = 20, _cursor, _order_by, _sort, _select, ...rest } = req.query as QueryOption<any>

        const filters = Object
            .keys(rest)
            .map(key => {
                const [name, expression] = key.split(':')
                try {
                    return [name, expression || 'eq', JSON.parse(rest[key])]
                } catch (e) {
                    return [name, expression || 'eq', rest[key]]
                }
            })

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
            filters,
            options: {
                _limit: Number(_limit),
                _cursor,
                _order_by,
                _sort,
                ..._select ? { _select: JSON.parse(_select as any as string) } : {}
            },
            keys: req.params,
            body: req.body,
            method: req.method.toLowerCase()
        } as any as LivequeryRequest

        // Allow realtime by default   
        req.method == 'GET' && req.headers.socket_id && this.LivequeryWebsocketSync?.listen(req.headers.socket_id, { collection_ref, doc_id })

        const realtime_token = await new Promise(s => {
            if (!this.secret_or_private_key || req.method.toLowerCase() != 'get' ) return s(null)
            JWT.sign({ collection_ref, doc_id } as RealtimeSubscription, this.secret_or_private_key, {}, (error, data) => s(error ? null : data))
        })
        return next.handle().pipe(
            map(data => ({ data: { ...data, realtime_token } }))
        )
    }
}


export const UseLivequeryInterceptor = () => UseInterceptors(LivequeryInterceptor)