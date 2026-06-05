import { ApiServiceLinker as CoreApiServiceLinker, UdpDiscovery, WebsocketGateway, type ServiceApiMetadata } from '@livequery/core'
import type { LivequeryRouteRegistry } from './route-registry.js'
import type { LivequeryRoute } from './types.js'

export type HonoApiServiceLinkerOptions = {
    routes: LivequeryRoute[] | LivequeryRouteRegistry
    websocketGateway?: WebsocketGateway
    discovery?: UdpDiscovery<ServiceApiMetadata>
}

export class HonoApiServiceLinker {
    readonly #linker: CoreApiServiceLinker

    constructor(options: HonoApiServiceLinkerOptions) {
        const linkerOptions: ConstructorParameters<typeof CoreApiServiceLinker>[0] = {
            paths: Array.isArray(options.routes) ? options.routes : options.routes.routes,
        }
        if (options.websocketGateway) linkerOptions.ws = options.websocketGateway
        if (options.discovery) linkerOptions.discovery = options.discovery
        this.#linker = new CoreApiServiceLinker(linkerOptions)
    }

    start(name: string, port: number): void {
        this.#linker.start(name, port)
    }

    close(): void {
        this.#linker.close()
    }
}
