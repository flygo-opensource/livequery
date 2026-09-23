import { createUdpTransport, type UdpTransportOptions } from './createUdpTransport.js'
import { DISCOVERY_NAMESPACE, DISCOVERY_TAG } from './const.js'
import type { ServiceAnnouncement, ServiceDiscoveryTransport } from './types.js'

export type AnnounceServiceOptions = {
    /** Service name; every instance of a service uses the same one. */
    name: string
    /** The port it listens on — gateways reach it at the sender's address. */
    port?: number
    /** Or its full base URL, when the sender's address is not the one to use (NAT, a proxy). */
    url?: string
    /** Path prefixes it owns. Or pass `app` to announce every route of a Hono app. */
    prefixes?: string[]
    app?: { routes: Array<{ path: string }> }
    /** How often to repeat the announcement (ms). Gateways drop a service silent for 3×. Default 5000. */
    interval?: number
    transport?: ServiceDiscoveryTransport
    udp?: UdpTransportOptions
}

export type AnnouncedService = {
    /** Say goodbye (gateways drop it at once) and stop announcing. */
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
 * Tell API gateways on the network that this service exists, where it is and which path prefixes
 * it owns — the gateway side is `discoverServices()`. UDP carries no "gone" signal, so the
 * announcement repeats every `interval`; `close()` sends a last one saying the service is leaving.
 *
 *   const announced = announceService({ name: 'tasks', port: 8081, app })
 *   process.on('SIGTERM', () => announced.close())
 */
export function announceService(options: AnnounceServiceOptions): AnnouncedService {
    const node_id = `${options.name}-${crypto.randomUUID()}`
    const transport = options.transport ?? createUdpTransport(node_id, options.udp)
    const prefixes = options.prefixes ?? (options.app ? prefixesOf(options.app) : [])
    if (prefixes.length === 0) throw new Error(`announceService("${options.name}"): no prefixes to announce`)
    let seq = 0
    const send = (data: ServiceAnnouncement) => transport.broadcast({
        node_id,
        namespace: DISCOVERY_NAMESPACE,
        tags: [DISCOVERY_TAG],
        version: '1',
        created_at: Date.now(),
        seq: ++seq,
        data,
    }).catch(e => console.warn('livequery discovery: announcing failed', e))
    const announcement: ServiceAnnouncement = {
        role: 'service',
        name: options.name,
        prefixes,
        ...options.url ? { url: options.url } : {},
        ...options.port !== undefined ? { port: options.port } : {},
    }

    void send(announcement)
    const timer = setInterval(() => void send(announcement), options.interval ?? 5000)
    ;(timer as { unref?: () => void }).unref?.()

    return {
        async close() {
            clearInterval(timer)
            await send({ ...announcement, leaving: true })
            transport.close()
        },
    }
}
