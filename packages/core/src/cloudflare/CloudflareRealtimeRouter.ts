import { LIVEQUERY_PRINCIPAL_HEADER } from './const.js'
import type { DurableObjectNamespaceLike } from './types.js'

export type {
    DurableObjectId,
    DurableObjectNamespaceLike,
    DurableObjectStubLike,
} from './types.js'

export type CloudflareRealtimeRouterOptions = {
    /** Must return a bounded shard such as tenant, room, document, or bucket. */
    shardKey(request: Request, principal?: string): string | Promise<string>
}

/** Stateless Worker-side router. The Durable Object owns WebSocket state. */
export class CloudflareRealtimeRouter {
    readonly #namespace: DurableObjectNamespaceLike
    readonly #shardKey: CloudflareRealtimeRouterOptions['shardKey']

    constructor(namespace: DurableObjectNamespaceLike, options: CloudflareRealtimeRouterOptions) {
        this.#namespace = namespace
        this.#shardKey = options.shardKey
    }

    /**
     * Forward a WebSocket upgrade to its shard. `principal` is the identity the Worker already
     * authenticated; it replaces any principal header the client sent.
     */
    async fetch(request: Request, principal?: string): Promise<Response> {
        if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
            return new Response('Expected WebSocket', { status: 426 })
        }
        const shard = await this.#shardKey(request, principal)
        if (!shard || shard.length > 256) {
            return Response.json(
                { error: { code: 'INVALID_REALTIME_SHARD', message: 'Invalid realtime shard key' } },
                { status: 400 },
            )
        }
        const headers = new Headers(request.headers)
        headers.delete(LIVEQUERY_PRINCIPAL_HEADER)
        if (principal !== undefined) headers.set(LIVEQUERY_PRINCIPAL_HEADER, principal)
        const forwarded = new Request(request, { headers })
        return this.#namespace.get(this.#namespace.idFromName(shard)).fetch(forwarded)
    }
}
