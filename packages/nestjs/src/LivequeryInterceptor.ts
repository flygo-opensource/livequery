import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor, Optional, UseInterceptors } from "@nestjs/common";
import { map } from "rxjs/operators";
import { hidePrivateFields, LivequeryRequestParser, WebsocketGateway, type LivequeryContext } from "@livequery/core";
import type { LivequeryRequest } from "@livequery/types";



@Injectable()
export class LivequeryInterceptor implements NestInterceptor {
    readonly #parser = new LivequeryRequestParser()

    constructor(
        @Optional() @Inject(WebsocketGateway) private WebsocketGateway?: WebsocketGateway
    ) {
    }

    async intercept(context: ExecutionContext, next: CallHandler) {

        const req = context.switchToHttp().getRequest()
        const ctx: LivequeryContext = {
            request: {
                path: req.originalUrl ?? req.url ?? req._parsedUrl?.pathname ?? '',
                ref: req.route?.path ?? req.path ?? req.url ?? '',
                params: req.params ?? {},
                query: req.query ?? {},
                body: req.body,
                method: req.method,
                headers: new Headers(req.headers as HeadersInit) as unknown as Map<string, string>,
            }
        }

        this.#parser.handle(ctx)

        const parsed = ctx.livequery
        if (parsed) {
            req.livequery = {
                ...parsed,
                schema_ref: parsed.schema_collection_ref,
                is_collection: parsed.document_id === undefined,
                doc_id: parsed.document_id,
                options: parsed.query,
                method: parsed.method.toLowerCase(),
            } as LivequeryRequest & typeof parsed
        }

        // Allow realtime by default    
        const cursor = req.query?.[':after'] || req.query?.[':before'] || req.query?.[':around']
        if (parsed && req.method === 'GET' && !cursor) {
            this.WebsocketGateway?.handle(ctx)
        }

        return next.handle().pipe(
            map(response => {
                if (response.item) {
                    return {
                        ...response,
                        item: hidePrivateFields(response.item.toJSON ? response.item.toJSON() : response.item),
                    }
                }
                return response
            })
        )
    }
}


export const UseLivequeryInterceptor = () => UseInterceptors(LivequeryInterceptor)
