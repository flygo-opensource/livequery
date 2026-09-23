import type { ServiceRouting, ServiceRoutingNode } from '@livequery/core'
import type { Subscription } from 'rxjs'
import { connect, type Socket } from 'node:net'
import { DISCOVERY_NAMESPACE, DISCOVERY_TAG } from './const.js'
import { createUdpTransport, type UdpTransportOptions } from './createUdpTransport.js'
import type { ServiceDiscoveryTransport } from './types.js'

export type DiscoverServicesOptions = {
    /** Routing declared up front; discovered services are added to it (and win on the same prefix). */
    routing?: ServiceRouting
    /** A service unreachable this long is forgotten (ms); until then it is retried. Default 1 hour. */
    forgetAfter?: number
    transport?: ServiceDiscoveryTransport
    udp?: UdpTransportOptions
}

export type ServiceDirectory = {
    /** The routing as known now: services the gateway is connected to; each call picks the next instance (round-robin). */
    routing(): ServiceRouting
    /** Services currently up: name → base URLs of their instances. */
    services(): Record<string, string[]>
    /**
     * A request to `url` failed: take that instance out until its connection is checked again. For
     * `gateway({ onServiceError })` — the quick way to notice a machine that went away without
     * closing its connections.
     */
    unreachable(target: string | { target: { url?: string } }): void
    close(): void
}

type Instance = {
    node_id: string
    name: string
    prefixes: string[]
    port?: number
    url?: string
    probe_port: number
    /** Every address the announcement was heard from; tried loopback first. */
    addresses: Set<string>
    /** Set while connected: where the service answered, and its base URL there. */
    live?: { address: string, url: string, socket: Socket }
    connecting: boolean
    retry?: ReturnType<typeof setTimeout>
    attempts: number
    down_since?: number
}

const CONNECT_TIMEOUT = 2_000
// Copies of one announcement arrive through every interface of the sender: wait for them before
// choosing where to connect.
const GATHER = 200

/**
 * Which address to try first: loopback (the service is on this machine), then a private LAN, then
 * anything else, and VPN/CGNAT addresses (100.64.0.0/10) last — a connection through a userspace
 * VPN can stay open on this side after the service is gone.
 */
function rank(address: string): number {
    if (address === '127.0.0.1' || address === '::1' || address.startsWith('127.')) return 0
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address)) return 1
    const [a, b] = address.split('.').map(Number)
    if (a === 100 && b !== undefined && b >= 64 && b <= 127) return 3
    return 2
}

// Connect to one address, or fail within CONNECT_TIMEOUT.
function probe(host: string, port: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const socket = connect({ host, port })
        const timer = setTimeout(() => socket.destroy(new Error('timeout')), CONNECT_TIMEOUT)
        socket.once('connect', () => {
            clearTimeout(timer)
            resolve(socket)
        })
        socket.once('error', error => {
            clearTimeout(timer)
            reject(error)
        })
    })
}

// Every `:param` becomes the same key, so two services naming a parameter differently still share
// the segment (the gateway matches any `:` key to any value).
const PARAM = ':param'

function addPrefix(tree: ServiceRoutingNode, prefix: string, name: string) {
    let node = tree
    for (const segment of prefix.split('/').filter(Boolean)) {
        const key = segment.startsWith(':') ? PARAM : segment
        node = (node[key] ??= {}) as ServiceRoutingNode
    }
    node.$service = name
}

// Declared routes, with their `:param` keys normalized like the discovered ones.
function normalize(node: ServiceRoutingNode): ServiceRoutingNode {
    const out: ServiceRoutingNode = {}
    for (const [key, value] of Object.entries(node)) {
        if (key.startsWith('$')) out[key] = value
        else if (value && typeof value === 'object') {
            const target = key.startsWith(':') ? PARAM : key
            out[target] = merge(out[target] as ServiceRoutingNode | undefined, normalize(value as ServiceRoutingNode))
        }
    }
    return out
}

function merge(a: ServiceRoutingNode | undefined, b: ServiceRoutingNode): ServiceRoutingNode {
    if (!a) return b
    const out: ServiceRoutingNode = { ...a }
    for (const [key, value] of Object.entries(b)) {
        out[key] = key.startsWith('$') || !value || typeof value !== 'object'
            ? value
            : merge(out[key] as ServiceRoutingNode | undefined, value as ServiceRoutingNode)
    }
    return out
}

/**
 * The gateway side of `announceService()`: learn services from the network and serve a routing
 * that follows them — for `gateway({ routing, onServiceError })` on Node and Bun.
 *
 *   const directory = discoverServices()
 *   app.use('*', gateway({ routing: directory.routing, onServiceError: directory.unreachable, realtime }))
 *
 * No heartbeat: the gateway connects to each announced instance and keeps the connection. The
 * instance is routed while it is open; when it closes — the process ended, even killed — the
 * instance is out at once and the gateway keeps trying to reconnect (1s, 2s, 4s… up to 30s), so a
 * network blip heals by itself. A machine that vanishes without closing is noticed by TCP
 * keepalive, or sooner by `unreachable()` when a request to it fails. On start the gateway says
 * hello, and services already running answer with their announcement.
 */
export function discoverServices(options: DiscoverServicesOptions = {}): ServiceDirectory {
    const node_id = `gateway-${crypto.randomUUID()}`
    const transport = options.transport ?? createUdpTransport(node_id, options.udp)
    const forget_after = options.forgetAfter ?? 3_600_000
    const instances = new Map<string, Instance>()
    const turns = new Map<string, number>()
    let closed = false

    const connectTo = async (instance: Instance) => {
        if (closed || instance.live || instance.connecting) return
        instance.connecting = true
        instance.retry && clearTimeout(instance.retry)
        instance.retry = undefined
        const addresses = [...instance.addresses].sort((a, b) => rank(a) - rank(b))
        for (const address of addresses) {
            const socket = await probe(address, instance.probe_port).catch(() => undefined)
            if (!socket) continue
            if (closed || !instances.has(instance.node_id)) {
                socket.destroy()
                break
            }
            socket.setKeepAlive(true, 5_000)
            socket.on('error', () => undefined)
            const host = address.includes(':') ? `[${address}]` : address
            instance.live = { address, url: instance.url ?? `http://${host}:${instance.port}`, socket }
            instance.attempts = 0
            instance.down_since = undefined
            // Closed by the other side: the service is gone (or the path to it is).
            socket.once('close', () => down(instance))
            instance.connecting = false
            return
        }
        instance.connecting = false
        schedule(instance)
    }

    const down = (instance: Instance) => {
        instance.live?.socket.destroy()
        instance.live = undefined
        instance.down_since ??= Date.now()
        schedule(instance)
    }

    const schedule = (instance: Instance) => {
        if (closed || instance.retry) return
        if (Date.now() - (instance.down_since ??= Date.now()) > forget_after) {
            instances.delete(instance.node_id)
            return
        }
        const delay = Math.min(1_000 * 2 ** instance.attempts++, 30_000)
        instance.retry = setTimeout(() => {
            instance.retry = undefined
            void connectTo(instance)
        }, delay)
        ;(instance.retry as { unref?: () => void }).unref?.()
    }

    const subscription: Subscription = transport.subscribe(message => {
        const { data } = message
        if (data.role !== 'service' || !data.name || !data.prefixes?.length || data.probe_port === undefined) return
        if (data.port === undefined && !data.url) return
        const instance = instances.get(message.node_id) ?? {
            node_id: message.node_id,
            name: data.name,
            prefixes: data.prefixes,
            port: data.port,
            url: data.url,
            probe_port: data.probe_port,
            addresses: new Set<string>(),
            connecting: false,
            attempts: 0,
        }
        instances.set(message.node_id, instance)
        if (message.remote_host) instance.addresses.add(message.remote_host)
        if (!instance.live && !instance.connecting && !instance.retry) {
            instance.retry = setTimeout(() => {
                instance.retry = undefined
                void connectTo(instance)
            }, GATHER)
        }
    })

    void transport.broadcast({
        node_id,
        namespace: DISCOVERY_NAMESPACE,
        tags: [DISCOVERY_TAG],
        version: '1',
        created_at: Date.now(),
        seq: 1,
        data: { role: 'gateway' },
    }).catch(e => console.warn('livequery discovery: hello failed', e))

    const up = () => [...instances.values()]
        .filter(instance => instance.live)
        .sort((a, b) => a.node_id < b.node_id ? -1 : 1)

    return {
        routing() {
            const declared = options.routing
            const services: ServiceRouting['services'] = { ...declared?.services }
            let routes: ServiceRoutingNode = declared ? normalize(declared.routes) : {}
            const by_name = new Map<string, Instance[]>()
            for (const instance of up()) by_name.set(instance.name, [...by_name.get(instance.name) ?? [], instance])
            for (const [name, group] of by_name) {
                const turn = turns.get(name) ?? 0
                turns.set(name, turn + 1)
                services[name] = { url: group[turn % group.length]!.live!.url }
                const discovered: ServiceRoutingNode = {}
                for (const instance of group) for (const prefix of instance.prefixes) addPrefix(discovered, prefix, name)
                routes = merge(routes, discovered)
            }
            return { services, routes }
        },
        services() {
            const out: Record<string, string[]> = {}
            for (const instance of up()) (out[instance.name] ??= []).push(instance.live!.url)
            return out
        },
        unreachable: target => {
            const url = typeof target === 'string' ? target : target.target.url
            if (!url) return
            for (const instance of instances.values()) {
                if (instance.live && url.startsWith(instance.live.url)) down(instance)
            }
        },
        close() {
            closed = true
            subscription.unsubscribe()
            for (const instance of instances.values()) {
                instance.retry && clearTimeout(instance.retry)
                instance.live?.socket.destroy()
            }
            instances.clear()
            transport.close()
        },
    }
}
