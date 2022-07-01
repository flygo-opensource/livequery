import { LivequeryRequest, QueryOption } from "@livequery/types";
import { CallHandler, ExecutionContext, HttpException, Injectable, NestInterceptor, Optional, UseInterceptors } from "@nestjs/common";
import { catchError, map } from "rxjs/operators";
import { PathHelper } from "./helpers/PathHelper";
import JWT from 'jsonwebtoken'
import { of } from "rxjs";
import { LivequeryWebsocketSync } from "./LivequeryWebsocketSync";
import { InjectWebsocketPrivateKey } from "./UseWebsocketShareKeyPair";


export type RealtimeSubscription = {
    collection_ref: string,
    doc_id: string
}

@Injectable()
export class LivequeryInterceptor implements NestInterceptor {

    constructor(
        @Optional() private LivequeryWebsocketSync: LivequeryWebsocketSync,
        @Optional() @InjectWebsocketPrivateKey() private secret_or_private_key: string
    ) {
        if (!LivequeryWebsocketSync && !secret_or_private_key) throw new Error('Missing api-websocket key pair, please use UseWebsocketShareKeyPair in providers list')
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
        req.headers.socket_id && this.LivequeryWebsocketSync?.listen(req.headers.socket_id, { collection_ref, doc_id })
        const realtime_key = await new Promise(s => {
            if (this.LivequeryWebsocketSync || req.method.toLowerCase() != 'get' || !req.query['realtime']) return {}
            const subscription_id = Date.now().toString(32)
            JWT.sign({ collection_ref, doc_id, filters, subscription_id } as RealtimeSubscription, this.secret_or_private_key, {}, (error, data) => s(error ? {} : data))
        })
        return next.handle().pipe(
            catchError(error => of({ error })),
            map(data => ({ data: { ...data, realtime_key } }))
        )
    }
}


export const UseLivequeryInterceptor = () => UseInterceptors(LivequeryInterceptor)