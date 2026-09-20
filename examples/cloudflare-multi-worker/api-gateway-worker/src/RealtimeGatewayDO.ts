import { DurableObject } from 'cloudflare:workers'
import { HibernatableWebsocketGateway } from '@livequery/core/workers'

/**
 * One realtime shard. Sockets use the Hibernation API, so an idle shard is evicted from memory
 * while its clients stay connected. Reachable only through the gateway's `REALTIME` binding.
 */
export class RealtimeGatewayDO extends DurableObject<GatewayEnv> {
    readonly #gateway: HibernatableWebsocketGateway

    constructor(ctx: DurableObjectState, env: GatewayEnv) {
        super(ctx, env)
        this.#gateway = new HibernatableWebsocketGateway(ctx)
    }

    override fetch(request: Request): Promise<Response> {
        return this.#gateway.fetch(request)
    }

    override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
        this.#gateway.webSocketMessage(ws, message)
    }

    override webSocketClose(ws: WebSocket): void {
        this.#gateway.webSocketClose(ws)
    }

    override webSocketError(ws: WebSocket): void {
        this.#gateway.webSocketError(ws)
    }
}
