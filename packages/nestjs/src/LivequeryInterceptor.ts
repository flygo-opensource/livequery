import { LivequeryRequest, QueryOption } from "@livequery/types";
import { CallHandler, ExecutionContext, HttpException, Injectable, NestInterceptor, Optional, UseInterceptors } from "@nestjs/common";
import { LivequeryWebsocketSync } from './LivequeryWebsocketSync'
import { LIVEQUERY_MAGIC_KEY } from "./const";
import { of } from 'rxjs'
import { catchError, map } from "rxjs/operators";
import { LivequeryRequestKey } from "index";

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


        const refs = (req._parsedUrl.pathname as string)
            ?.split(LIVEQUERY_MAGIC_KEY)
            ?.[1]
            ?.split('/')

        if (!refs) throw new HttpException('CAN_NOT_DETECT_LIVEQUERY_KEY', 400)

        const ref = refs.join('/')
        const is_collection = refs.length % 2 == 1
        const collection_ref = refs.slice(0, refs.length - (is_collection ? 0 : 1)).join('/')
        const doc_id = !is_collection && refs[refs.length - 1]

        const schema_collection_ref = (req.route.path as string)
            ?.split(LIVEQUERY_MAGIC_KEY)
            ?.[1]
            ?.split('/')
            ?.filter((_, i) => i % 2 == 0)
            ?.join('/')
            ?.replaceAll(':', '')

        if (!schema_collection_ref) throw new HttpException('CAN_NOT_DETECT_LIVEQUERY_KEY', 400)

        req[LivequeryRequestKey] = {
            ref,
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
            keys: req.params
        } as LivequeryRequest

        // Add socket
        const socket_id = req.headers.socket_id
        socket_id && this.LivequeryWebsocketSync?.listen(socket_id, collection_ref, doc_id)
        return next.handle().pipe(
            map(data => ({ data })),
            catchError(error => of({ error }))
        )
    }
}


export const UseLivequeryInterceptor = () => UseInterceptors(LivequeryInterceptor)