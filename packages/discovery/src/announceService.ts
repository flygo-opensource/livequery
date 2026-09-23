import { createServer, type Socket } from 'node:net'
import { DISCOVERY_NAMESPACE, DISCOVERY_TAG } from './const.js'
import { createUdpTransport, type UdpTransportOptions } from './createUdpTransport.js'
import type { ServiceAnnouncement, ServiceDiscoveryTransport } from './types.js'

export type AnnounceServiceOptions = {
    /** Service name; every instance of a service uses the same one. */
    name: string
    /** The port it listens on — gateways reach it at the address that answers their connection. */
    port?: number
    /** Or its full base URL, when that address is not the one to use (NAT, a proxy). */
    url?: string
    /** Path prefixes it owns. Or pass `app` to announce every route of a Hono app. */
    prefixes?: string[]
    app?: { routes: Array<{ path: string }> }
    transport?: ServiceDiscoveryTransport
    udp?: UdpTransportOptions
}

export type AnnouncedService = {
    /** The TCP port gateways connect to. */
    readonly probe_port: number
    /** Stop being reachable: gateways connected to it drop the service at once. */
    close(): Promise<void>
}

// The Livequery routes of a Hono app, as prefixes.
function prefixesOf(app: { routes: Array<{ path: string }> }): string[] {
    const paths = app.routes
        .map(route => route.path.replace(/\/\*$/, ''))
        .filter(path => path.startsWith('/livequery/') && !path.includes('*'))
    return [...new Set(paths)]
}

/**
 * Tell API gateways on the network that this service exists — the gateway side is
 * `discoverServices()`. The announcement goes out once (a gateway started later gets it in answer
 * to its hello); there is no heartbeat. Instead each gateway connects to the service's probe port
 * and keeps the connection: when this process ends, even killed, the connection closes and the
 * gateway drops the service.
 *
 *   const announced = await announceService({ name: 'tasks', port: 8081, app })
 */
export async function announceService(options: AnnounceServiceOptions): Promise<AnnouncedService> {
    const node_id = `${options.name}-${crypto.randomUUID()}`
    const prefixes = options.prefixes ?? (options.app ? prefixesOf(options.app) : [])
    if (prefixes.length === 0) throw new Error(`announceService("${options.name}"): no prefixes to announce`)

    // Gateways hold one idle connection each; nothing is ever sent on it.
    const sockets = new Set<Socket>()
    const server = createServer(socket => {
        sockets.add(socket)
        socket.setKeepAlive(true, 5_000)
        socket.on('error', () => undefined)
        socket.on('close', () => sockets.delete(socket))
    })
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, () => resolve())
    })
    const probe_port = (server.address() as { port: number }).port

    const transport = options.transport ?? createUdpTransport(node_id, options.udp)
    const announcement: ServiceAnnouncement = {
        role: 'service',
        name: options.name,
        prefixes,
        probe_port,
        ...options.url ? { url: options.url } : {},
        ...options.port !== undefined ? { port: options.port } : {},
    }
    await transport.broadcast({
        node_id,
        namespace: DISCOVERY_NAMESPACE,
        tags: [DISCOVERY_TAG],
        version: '1',
        created_at: Date.now(),
        seq: 1,
        data: announcement,
    }).catch(e => console.warn('livequery discovery: announcing failed', e))

    return {
        probe_port,
        async close() {
            for (const socket of sockets) socket.destroy()
            await new Promise<void>(resolve => server.close(() => resolve()))
            transport.close()
        },
    }
}
