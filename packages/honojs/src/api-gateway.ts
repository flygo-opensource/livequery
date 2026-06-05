import type { Context, Handler } from 'hono'
import {
    ApiGatewayHandler,
    UdpDiscovery,
    WebsocketGateway,
    type ServiceApiMetadata,
} from '@livequery/core'

export type HonoApiGatewayOptions = {
    websocketGateway?: WebsocketGateway
    discovery?: UdpDiscovery<ServiceApiMetadata>
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
