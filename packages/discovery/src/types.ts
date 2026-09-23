import type { Observable } from 'rxjs'

/** What a service tells gateways about itself, and what a gateway says when it starts. */
export type ServiceAnnouncement = {
    role: 'service' | 'gateway'
    /** Service name: instances with the same name share its prefixes and its traffic. */
    name?: string
    /** Where to reach it. Without `url`, the gateway uses the sender's address and `port`. */
    url?: string
    port?: number
    /** Path prefixes it owns, e.g. `/livequery/tasks`; `:param` segments match any segment. */
    prefixes?: string[]
    /**
     * TCP port a gateway connects to and keeps open: while the connection lives, the service is up;
     * when it closes (the process exits, even killed), the gateway drops the service at once.
     */
    probe_port?: number
}

/**
 * The transport — `UdpDiscovery` from `@simple-discovery/udp` by default. Any `@simple-discovery`
 * transport fits (HTTP, NATS, Redis, AMQP): the same signed envelope, delivered differently.
 */
export type ServiceDiscoveryTransport = Observable<ServiceDiscoveryMessage> & {
    broadcast(message: ServiceDiscoveryMessage): Promise<void>
    close(): void
}

export type ServiceDiscoveryMessage = {
    node_id: string
    namespace: string
    tags: string[]
    version: string
    created_at: number
    seq: number
    data: ServiceAnnouncement
    remote_host?: string
}
