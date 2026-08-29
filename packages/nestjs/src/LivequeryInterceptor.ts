import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor, Optional, UseInterceptors } from "@nestjs/common";
import { map } from "rxjs/operators";
import { hidePrivateFields, LivequeryRequestParser, WebsocketGateway, type LivequeryContext } from "@livequery/core";
import type { LivequeryRequest } from "@livequery/core";



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
            map(response => maskLivequeryResponse(response))
        )
    }
}

function toPlain(item: any) {
    return item && typeof item.toJSON === 'function' ? item.toJSON() : item
}

// Hide private (underscore-prefixed) fields on every livequery payload shape:
// bare `{ item }`, bare `{ items }`, and either of those inside the `{ data }` envelope.
function maskLivequeryResponse(response: any): any {
    if (!response || typeof response !== 'object') return response
    let masked = response
    if (masked.item) {
        masked = { ...masked, item: hidePrivateFields(toPlain(masked.item)) }
    }
    if (Array.isArray(masked.items)) {
        masked = { ...masked, items: masked.items.map((item: any) => hidePrivateFields(toPlain(item))) }
    }
    if (masked.data && typeof masked.data === 'object') {
        masked = { ...masked, data: maskLivequeryResponse(masked.data) }
    }
    return masked
}


export const UseLivequeryInterceptor = () => UseInterceptors(LivequeryInterceptor)
