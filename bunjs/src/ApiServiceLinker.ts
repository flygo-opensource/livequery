import { randomUUID } from 'crypto'
import { Subscription } from 'rxjs'
import {
    API_GATEWAY_NAMESPACE,
    OHAYO_DISCOVERY_KEY,
    WEBSOCKET_PATH,
} from './const.js'
import {
    isDiscoveryOfflineData,
    type Discovery,
    type DiscoveryMessage,
} from './Discovery.js'
import { HttpDiscovery } from './HttpDiscovery.js'
import { WebsocketGatewayBase } from './WebsocketGatewayBase.js'
import { ServiceApiMetadata } from './ApiGatewayHandler.js'

export type ApiServiceLinkerOptions = {
    paths: Array<{ method: string; path: string }>
    ws?: WebsocketGatewayBase
    discovery?: Discovery<ServiceApiMetadata>
    node_id?: string
}

export class ApiServiceLinker {
    readonly #paths: Array<{ method: string; path: string }>
    readonly #nodeId: string
    readonly #lws?: WebsocketGatewayBase
    readonly #discovery: Discovery<ServiceApiMetadata>
    #subscription?: Subscription
    #metadata?: DiscoveryMessage<ServiceApiMetadata>
    readonly #gatewayAnnouncements = new Map<string, string>()
    #seq = 0

    constructor(options: ApiServiceLinkerOptions) {
        this.#paths = options.paths
        this.#nodeId = options.node_id ?? randomUUID()
        this.#lws = options.ws
        this.#discovery = options.discovery ?? new HttpDiscovery<ServiceApiMetadata>({
            key: OHAYO_DISCOVERY_KEY,
            namespace: API_GATEWAY_NAMESPACE,
            tags: ['livequery'],
            node_id: this.#nodeId,
            listen: false,
        })
    }

    start(name: string, port: number): void {
        this.#metadata = this.#createMetadata(name, port)
        this.#gatewayAnnouncements.clear()
        this.#subscription?.unsubscribe()
        this.#subscription = this.#discovery.subscribe(message => {
            if (message.namespace !== API_GATEWAY_NAMESPACE) return
            if (message.node_id === this.#nodeId) return
            if (isDiscoveryOfflineData(message.data)) return
            const discovered = message.data as ServiceApiMetadata
            if (discovered.role !== 'gateway') return
            const marker = `${message.seq}:${message.version}:${message.created_at}`
            if (this.#gatewayAnnouncements.get(message.node_id) === marker) return
            this.#gatewayAnnouncements.set(message.node_id, marker)
            const current = this.#metadata
            if (current) this.#discovery.broadcast(this.#bump(current)).catch(e => console.error(e))
        })
        this.#discovery.broadcast(this.#metadata).catch(e => console.error(e))
    }

    close(): void {
        this.#subscription?.unsubscribe()
        this.#discovery.close()
    }

    #createMetadata(name: string, port: number): DiscoveryMessage<ServiceApiMetadata> {
        const now = Date.now()
        return {
            node_id: this.#nodeId,
            namespace: API_GATEWAY_NAMESPACE,
            tags: ['livequery', 'service'],
            version: String(now),
            created_at: now,
            seq: ++this.#seq,
            data: {
                host: process.env.OHAYO_SERVICE_HOST || '',
                name,
                port,
                role: 'service',
                paths: this.#paths,
                linked: [],
                ws: this.#lws ? {
                    auth: this.#lws.auth,
                    path: WEBSOCKET_PATH,
                } : undefined,
            },
        }
    }

    #bump(metadata: DiscoveryMessage<ServiceApiMetadata>): DiscoveryMessage<ServiceApiMetadata> {
        const now = Date.now()
        this.#seq = Math.max(this.#seq, metadata.seq)
        return {
            ...metadata,
            version: String(now),
            created_at: now,
            seq: ++this.#seq,
        }
    }

}
