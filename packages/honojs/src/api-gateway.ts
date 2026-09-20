import type { Context, Handler } from 'hono'
// The /bun entry of core loads no `ws` and no UDP transport, so this module also runs on Node.
import {
    ApiGatewayHandler,
    type Discovery,
    type ServiceApiMetadata,
    type WebsocketGatewayBase,
} from '@livequery/core/bun'

export type HonoApiGatewayOptions = {
    websocketGateway?: WebsocketGatewayBase
    /** Any discovery transport: `HttpDiscovery`, or `UdpDiscovery` from `@livequery/core/udp`. */
    discovery?: Discovery<ServiceApiMetadata>
    node_id?: string
}

export class HonoApiGateway extends ApiGatewayHandler {
    constructor(options: HonoApiGatewayOptions = {}) {
        super(options)
    }
}

export class HonoApiGatewayLinker {
    readonly #handler: ApiGatewayHandler

    constructor(options: HonoApiGatewayOptions = {}) {
        this.#handler = new ApiGatewayHandler({
            ...(options.websocketGateway ? { ws: options.websocketGateway } : {}),
            ...(options.discovery ? { discovery: options.discovery } : {}),
            ...(options.node_id ? { node_id: options.node_id } : {}),
        })
    }

    get gateway(): ApiGatewayHandler {
        return this.#handler
    }

    handler(): Handler {
        return async c => this.fetch(c)
    }

    fetch(c: Context): Promise<Response> {
        return this.#handler.fetchRequest(c.req.raw)
    }

    close(): void {
        this.#handler.close()
    }
}
