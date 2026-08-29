import { EdgeWebsocketGateway } from '@livequery/core/workers'
import type { UpdatedData } from '@livequery/core'
import type { RealtimeSubscription } from '@livequery/core/workers'

/**
 * Durable Object that owns WebSocket connections for realtime updates.
 *
 * Endpoints (all via stub.fetch):
 *   GET  /ws          — WebSocket upgrade (client connects here)
 *   POST /broadcast   — Worker notifies the DO of a data change after a write
 *   POST /subscribe   — Worker registers a subscription on behalf of an HTTP GET
 *
 * wrangler.toml:
 *   [[durable_objects.bindings]]
 *   name = "GATEWAY"
 *   class_name = "RealtimeGatewayDO"
 *
 *   [[migrations]]
 *   tag = "v1"
 *   new_classes = ["RealtimeGatewayDO"]
 */
export class RealtimeGatewayDO {
    readonly #ws = new EdgeWebsocketGateway()

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url)

        if (url.pathname === '/ws') {
            return this.#ws.handleRequest(request)
        }

        if (request.method !== 'POST') {
            return new Response('Not found', { status: 404 })
        }

        if (url.pathname === '/broadcast') {
            const update = await request.json<UpdatedData>()
            this.#ws.next(update)
            return new Response(null, { status: 204 })
        }

        if (url.pathname === '/subscribe') {
            const sub = await request.json<RealtimeSubscription>()
            this.#ws.listen([sub])
            return new Response(null, { status: 204 })
        }

        return new Response('Not found', { status: 404 })
    }
}
