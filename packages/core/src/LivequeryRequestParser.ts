import type { LivequeryContext, LivequeryHandler, LivequeryRequest, RawRequest } from './LivequeryContext.js'

export type HttpRequestContext = {
    pathname: string
    routePath: string
    query: Record<string, any>
    params: Record<string, any>
    body?: any
    method: string
}

export class LivequeryRequestParser implements LivequeryHandler {

    static parse(request: RawRequest): LivequeryRequest<any> | undefined {
        const refs = this.#routePath(request.ref).split('/').filter(Boolean)
        const paths = this.#routePath(request.path).split('/').filter(Boolean)
        this.#assertLivequeryPath(refs, request.ref)
        this.#assertLivequeryPath(paths, request.path)

        const is_document = refs[refs.length - 1]?.startsWith(':')
        const document_id = is_document ? paths[refs.length - 1] : undefined
        const collection = is_document ? refs[refs.length - 2] : refs[refs.length - 1]
        const ref = paths.slice(1).join('/')

        const collection_ref = paths.slice(1, document_id ? paths.length - 1 : undefined).join('/')
        const schemaSegments = refs.slice(1, document_id ? refs.length - 1 : undefined)
        const schema = schemaSegments.join('/')
        const schema_collection_ref = schemaSegments.map(c => c.startsWith(':') ? c.slice(1) : c).join('/')
        const keys = refs
            .filter(segment => segment.startsWith(':'))
            .map(segment => segment.slice(1))
            .reduce<Record<string, any>>((params, key) => {
                if (key in request.params) params[key] = request.params[key]
                return params
            }, {}
            )


        return {
            ref,
            collection_ref,
            collection,
            schema,
            schema_collection_ref,
            document_id,
            action: this.#action(request.path),
            keys,
            body: request.body,
            method: request.method.toUpperCase(),
            path: request.path,
            query: request.query,
        }
    }

    static #routePath(path: string) {
        const queryIndex = path.indexOf('?')
        const pathname = queryIndex === -1 ? path : path.slice(0, queryIndex)
        return pathname.split('~')[0]
    }

    static #assertLivequeryPath(segments: string[], path: string) {
        if (segments[0] !== 'livequery') {
            throw new Error(`Livequery path must start with "livequery": ${path}`)
        }
    }

    // Extract the custom action verb that follows `~` in the path (e.g. `.../orders/o1~approve`
    // → "approve"). Returns undefined when there is no `~` suffix. Query string is ignored.
    static #action(path: string): string | undefined {
        const pathname = path.indexOf('?') === -1 ? path : path.slice(0, path.indexOf('?'))
        const idx = pathname.indexOf('~')
        if (idx === -1) return undefined
        return pathname.slice(idx + 1).replace(/\/+$/, '') || undefined
    }

    handle(ctx: LivequeryContext) {
        ctx.livequery = LivequeryRequestParser.parse(ctx.request)
        return ctx.livequery
    }
} 
