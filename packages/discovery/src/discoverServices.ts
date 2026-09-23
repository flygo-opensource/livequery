import type { ServiceRouting, ServiceRoutingNode } from '@livequery/core'
import type { Subscription } from 'rxjs'
import { DISCOVERY_NAMESPACE, DISCOVERY_TAG } from './const.js'
import { createUdpTransport, type UdpTransportOptions } from './createUdpTransport.js'
import type { ServiceDiscoveryMessage, ServiceDiscoveryTransport } from './types.js'

export type DiscoverServicesOptions = {
    /** Routing declared up front; discovered services are added to it (and win on the same prefix). */
    routing?: ServiceRouting
    /** A service silent for this long is dropped (ms). Default 15000 — three announcements. */
    ttl?: number
    transport?: ServiceDiscoveryTransport
    udp?: UdpTransportOptions
}

export type ServiceDirectory = {
    /** The routing as known now; each call picks the next instance of every service (round-robin). */
    routing(): ServiceRouting
    /** Services currently known: name → base URLs of their live instances. */
    services(): Record<string, string[]>
    close(): void
}

type Instance = { node_id: string, name: string, url: string, address?: string, prefixes: string[], seen_at: number }

const LOOPBACK = '127.0.0.1'

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
 * that follows them — for `gateway({ routing: directory.routing })` on Node and Bun.
 *
 *   const directory = discoverServices()
 *   app.use('*', gateway({ routing: directory.routing, realtime }))
 *
 * Instances of one service share its traffic in turn. One that stops announcing is dropped after
 * `ttl`, one that says it is leaving at once. On start the gateway says hello, so services already
 * running answer right away instead of at their next announcement.
 */
export function discoverServices(options: DiscoverServicesOptions = {}): ServiceDirectory {
    const node_id = `gateway-${crypto.randomUUID()}`
    const transport = options.transport ?? createUdpTransport(node_id, options.udp)
    const ttl = options.ttl ?? 15_000
    const instances = new Map<string, Instance>()
    const turns = new Map<string, number>()

    const subscription: Subscription = transport.subscribe(message => {
        const { data } = message
        if (data.role !== 'service' || !data.name) return
        if (data.leaving) {
            instances.delete(message.node_id)
            return
        }
        if (!data.prefixes?.length) return
        const known = instances.get(message.node_id)
        // One announcement can arrive through several interfaces (VPNs, loopback), each with its own
        // source address: keep the address first heard — or loopback, for a service on this machine
        // — instead of following whichever copy came last.
        const host = message.remote_host
        const address = known?.address === LOOPBACK || !host ? known?.address ?? host : host === LOOPBACK ? host : known?.address ?? host
        const url = data.url ?? (address && data.port !== undefined
            ? `http://${address.includes(':') ? `[${address}]` : address}:${data.port}`
            : undefined)
        if (!url) return
        instances.set(message.node_id, { node_id: message.node_id, name: data.name, url, address, prefixes: data.prefixes, seen_at: Date.now() })
    })

    const hello: ServiceDiscoveryMessage = {
        node_id,
        namespace: DISCOVERY_NAMESPACE,
        tags: [DISCOVERY_TAG],
        version: '1',
        created_at: Date.now(),
        seq: 1,
        data: { role: 'gateway' },
    }
    void transport.broadcast(hello).catch(e => console.warn('livequery discovery: hello failed', e))

    const live = () => {
        const now = Date.now()
        for (const [id, instance] of instances) if (now - instance.seen_at > ttl) instances.delete(id)
        return [...instances.values()].sort((a, b) => a.node_id < b.node_id ? -1 : 1)
    }

    return {
        routing() {
            const declared = options.routing
            const services: ServiceRouting['services'] = { ...declared?.services }
            let routes: ServiceRoutingNode = declared ? normalize(declared.routes) : {}
            const by_name = new Map<string, Instance[]>()
            for (const instance of live()) by_name.set(instance.name, [...by_name.get(instance.name) ?? [], instance])
            for (const [name, group] of by_name) {
                const turn = turns.get(name) ?? 0
                turns.set(name, turn + 1)
                services[name] = { url: group[turn % group.length]!.url }
                const discovered: ServiceRoutingNode = {}
                for (const instance of group) for (const prefix of instance.prefixes) addPrefix(discovered, prefix, name)
                routes = merge(routes, discovered)
            }
            return { services, routes }
        },
        services() {
            const out: Record<string, string[]> = {}
            for (const instance of live()) (out[instance.name] ??= []).push(instance.url)
            return out
        },
        close() {
            subscription.unsubscribe()
            transport.close()
        },
    }
}
