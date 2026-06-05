import type { LivequeryContext, LivequeryHandler, RawRequest } from './LivequeryContext.js'
import type { WebsocketGateway } from './WebsocketGateway.js'

export type HttpRequestContext = {
    pathname: string
    routePath: string
    query: Record<string, any>
    params: Record<string, any>
    body?: any
    method: string
}

export class LivequeryRequestParser implements LivequeryHandler {

    #parse(request: RawRequest) {
        const refs = this.#routePath(request.ref).split('/').filter(Boolean)
        if (refs.length === 0) return
        const paths = this.#routePath(request.path).split('/').filter(Boolean)

        const start = refs.findIndex((p, i) => !refs[i + 1] || refs[i + 1].startsWith(':'))
        const document_id = refs[refs.length - 1]?.startsWith(':') ? paths[refs.length - 1] : undefined
        const ref = paths.slice(start).join('/')
        const collection_ref = paths.slice(start, document_id ? paths.length - 1 : undefined).join('/')
        const schema_collection_ref = refs.slice(start, document_id ? refs.length - 1 : undefined).map(c => c.startsWith(':') ? c.slice(1) : c).join('/')


        return {
            ref,
            collection_ref,
            schema_collection_ref,
            document_id,
            action: this.#action(request.path),
            keys: request.params,
            body: request.body,
            method: request.method.toUpperCase(),
            path: request.path,
            query: request.query,
        }
    }

    #routePath(path: string) {
        const queryIndex = path.indexOf('?')
        const pathname = queryIndex === -1 ? path : path.slice(0, queryIndex)
        return pathname.split('~')[0]
    }

    // Extract the custom action verb that follows `~` in the path (e.g. `.../orders/o1~approve`
    // → "approve"). Returns undefined when there is no `~` suffix. Query string is ignored.
    #action(path: string): string | undefined {
        const pathname = path.indexOf('?') === -1 ? path : path.slice(0, path.indexOf('?'))
        const idx = pathname.indexOf('~')
        if (idx === -1) return undefined
        return pathname.slice(idx + 1).replace(/\/+$/, '') || undefined
    }

    handle(ctx: LivequeryContext) {
        ctx.livequery = this.#parse(ctx.request)
        return ctx.livequery
    }
} 
