// The /bun entry of core loads no `ws` and no UDP transport, so this module also runs on Node.
import {
    ApiServiceLinker as CoreApiServiceLinker,
    type Discovery,
    type ServiceApiMetadata,
    type WebsocketGatewayBase,
} from '@livequery/core/bun'
import type { LivequeryRouteRegistry } from './route-registry.js'
import type { LivequeryRoute } from './types.js'

export type HonoApiServiceLinkerOptions = {
    routes: LivequeryRoute[] | LivequeryRouteRegistry
    websocketGateway?: WebsocketGatewayBase
    /** Any discovery transport: `HttpDiscovery`, or `UdpDiscovery` from `@livequery/core/udp`. */
    discovery?: Discovery<ServiceApiMetadata>
    node_id?: string
}

export class HonoApiServiceLinker {
    readonly #linker: CoreApiServiceLinker

    constructor(options: HonoApiServiceLinkerOptions) {
        const linkerOptions: ConstructorParameters<typeof CoreApiServiceLinker>[0] = {
            paths: Array.isArray(options.routes) ? options.routes : options.routes.routes,
        }
        if (options.websocketGateway) linkerOptions.ws = options.websocketGateway
        if (options.discovery) linkerOptions.discovery = options.discovery
        if (options.node_id) linkerOptions.node_id = options.node_id
        this.#linker = new CoreApiServiceLinker(linkerOptions)
    }

    start(name: string, port: number): void {
        this.#linker.start(name, port)
    }

    close(): void {
        this.#linker.close()
    }
}
