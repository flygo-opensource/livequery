import { randomUUID } from 'crypto'
import { Subscription } from 'rxjs'
import {
    API_GATEWAY_NAMESPACE,
    LIVEQUERY_MAGIC_KEY,
    WEBSOCKET_PATH,
} from './const.js'
import { UdpDiscovery } from './UdpDiscovery.js'
import { WebsocketGateway } from './WebsocketGateway.js'
import { ServiceApiMetadata } from './ApiGatewayHandler.js'

export type ApiServiceLinkerOptions = {
    paths: Array<{ method: string; path: string }>
    ws?: WebsocketGateway
    discovery?: UdpDiscovery<ServiceApiMetadata>
    node_id?: string
}

export class ApiServiceLinker {
    readonly #paths: Array<{ method: string; path: string }>
    readonly #nodeId: string
    readonly #lws?: WebsocketGateway
    readonly #discovery: UdpDiscovery<ServiceApiMetadata>
    #subscription?: Subscription
    #metadata?: ServiceApiMetadata

    constructor(options: ApiServiceLinkerOptions) {
        this.#paths = options.paths
        this.#nodeId = options.node_id ?? randomUUID()
        this.#lws = options.ws
        this.#discovery = options.discovery ?? new UdpDiscovery<ServiceApiMetadata>({ key: LIVEQUERY_MAGIC_KEY })
    }

    start(name: string, port: number): void {
        this.#metadata = this.#createMetadata(name, port)
        this.#subscription?.unsubscribe()
        this.#subscription = this.#discovery.subscribe(node => {
            if (node.role !== 'gateway') return
            if (node.namespace !== API_GATEWAY_NAMESPACE) return
            if (node.node_id === this.#nodeId) return
            const metadata = this.#metadata
            if (metadata) this.#discovery.broadcast(this.#bump(metadata)).catch(e => console.error(e))
        })
        this.#discovery.broadcast(this.#metadata).catch(e => console.error(e))
    }

    close(): void {
        this.#subscription?.unsubscribe()
        this.#discovery.close()
    }

    #createMetadata(name: string, port: number): ServiceApiMetadata {
        return {
            node_id: this.#nodeId,
            host: '',
            namespace: API_GATEWAY_NAMESPACE,
            version: Date.now(),
            name,
            port,
            role: 'service',
            paths: this.#paths,
            linked: [],
            ws: this.#lws ? {
                auth: this.#lws.auth,
                path: WEBSOCKET_PATH,
            } : undefined,
        }
    }

    #bump(metadata: ServiceApiMetadata): ServiceApiMetadata {
        return {
            ...metadata,
            version: Date.now(),
        }
    }
}
