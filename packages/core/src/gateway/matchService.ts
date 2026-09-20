import type { MatchedService, ServiceRouting, ServiceRoutingNode } from './types.js'

function childOf(node: ServiceRoutingNode, segment: string): ServiceRoutingNode | undefined {
    const literal = node[segment]
    if (literal && typeof literal === 'object') return literal as ServiceRoutingNode
    // No literal match: fall back to the single `:param` child, which matches any segment.
    for (const [key, value] of Object.entries(node)) {
        if (key.startsWith(':') && value && typeof value === 'object') return value as ServiceRoutingNode
    }
    return undefined
}

/**
 * Find the service that owns `pathname`, walking the routing tree segment by segment and keeping
 * the deepest `$service`. A nested owner therefore wins over the prefix above it.
 */
export function matchService(routing: ServiceRouting, pathname: string): MatchedService | undefined {
    let node: ServiceRoutingNode | undefined = routing.routes
    let name: string | undefined
    let auth: 'public' | 'required' = 'required'

    for (const segment of pathname.split('/').filter(Boolean)) {
        node = node && childOf(node, segment)
        if (!node) break
        if (node.$service) name = node.$service
        if (node.$auth) auth = node.$auth
    }

    if (!name) return undefined
    const target = routing.services[name]
    if (!target) throw new Error(`Routing names service "${name}", which is missing from services`)
    return { name, target, auth }
}
