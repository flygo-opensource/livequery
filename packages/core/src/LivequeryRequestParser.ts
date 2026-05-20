import type { LivequeryContext, LivequeryHandler, RawRequest } from './LivequeryContext.js'
import type { WebsocketGateway } from './WebsocketGateway.js'
import { LIVEQUERY_MAGIC_KEY } from './const.js'
 

export class LivequeryRequestParser implements LivequeryHandler {

    constructor(public ws?: WebsocketGateway) { }

    #parse(request: RawRequest) {
        const paths = this.#livequerySegments(request.path)
        const refs = this.#livequerySegments(request.ref).map(segment => segment.replaceAll(':', ''))
        if (paths.length === 0) return

        const lastRef = this.#livequerySegments(request.ref).at(-1)
        const isDocument = lastRef?.startsWith(':') || paths.length % 2 === 0
        const document_id = isDocument ? paths.at(-1) : undefined
        const collectionEnd = isDocument ? paths.length - 1 : paths.length
        const schemaEnd = isDocument ? refs.length - 1 : refs.length
        const ref = paths.join('/')
        const collection_ref = paths.slice(0, collectionEnd).join('/')
        const schema_collection_ref = refs.slice(0, schemaEnd).join('/')

        return {
            ref,
            collection_ref,
            schema_collection_ref,
            document_id,
            keys: request.params,
            body: request.body,
            method: request.method.toUpperCase(),
            path: request.path,
            query: request.query
        }
    }

    #livequerySegments(path: string): string[] {
        const magicKey = LIVEQUERY_MAGIC_KEY.replaceAll('/', '')
        const segments = path
            .split('?')[0]
            .split('~')[0]
            .split('/')
            .filter(Boolean)
        const start = segments.indexOf(magicKey)
        return (start === -1 ? segments : segments.slice(start + 1))
    }

    handle(ctx: LivequeryContext) {
        ctx.livequery = this.#parse(ctx.request)
    }
}
