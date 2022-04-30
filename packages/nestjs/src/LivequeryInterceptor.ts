import { LivequeryRequest, QueryOption } from "@livequery/types";
import { CallHandler, ExecutionContext, HttpException, Injectable, NestInterceptor, Optional, UseInterceptors } from "@nestjs/common";
import { LivequeryWebsocketSync } from './LivequeryWebsocketSync'
import { of } from 'rxjs'
import { catchError, map } from "rxjs/operators";
import { PathHelper } from "./PathHelper";

@Injectable()
export class LivequeryInterceptor implements NestInterceptor {

    constructor(
        @Optional() private LivequeryWebsocketSync: LivequeryWebsocketSync = null
    ) { }

    intercept(context: ExecutionContext, next: CallHandler) {

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

        } = PathHelper.livequeryPathExtractor(req._parsedUrl.pathname)

        const {
            collection_ref: schema_collection_ref,
            ref:schema_ref
        } = PathHelper.livequeryPathExtractor(req.route.path)

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
        const socket_id = req.headers.socket_id
        socket_id && this.LivequeryWebsocketSync?.listen(socket_id, collection_ref, doc_id)
        return next.handle().pipe(
            map(data => ({ data }))
        )
    }
}


export const UseLivequeryInterceptor = () => UseInterceptors(LivequeryInterceptor)