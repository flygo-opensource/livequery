import { DurableObject } from 'cloudflare:workers'
import { HibernatableWebsocketGateway } from '@livequery/core/workers'
import type { Env } from './types.js'

/**
 * One realtime shard. Sockets use the Hibernation API, so an idle shard is evicted from memory
 * (and stops billing duration) while its clients stay connected.
 *
 * Reachable only through the `GATEWAY` binding: the Worker forwards authenticated WebSocket
 * upgrades and calls the internal broadcast / subscribe endpoints.
 */
export class RealtimeGatewayDO extends DurableObject<Env> {
    readonly #gateway: HibernatableWebsocketGateway

    constructor(ctx: DurableObjectState, env: Env) {
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
    override alarm(): Promise<void> {
        return this.#gateway.alarm()
    }
}
