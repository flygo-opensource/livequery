/** Where a service can be reached: a Worker service binding, or a URL on Node/Bun. */
export type ServiceTarget = {
    /** Name of a Service Binding on `env`, used on Cloudflare. */
    binding?: string
    /** Base URL, used when there is no binding (Node, Bun, or a remote service). */
    url?: string
}

/**
 * One path segment of the routing tree. Keys that start with `$` are metadata; every other key is
 * a segment, and a `:name` key matches any single segment. `$service` and `$auth` are inherited by
 * everything below the node that declares them.
 */
export type ServiceRoutingNode = {
    $service?: string
    $auth?: 'public' | 'required'
} & {
    [segment: string]: ServiceRoutingNode | string | undefined
}

/**
 * Prefix routing for a gateway: which service owns which path prefix. Routes below a prefix are
 * the owning service's business, so adding one needs no gateway deploy.
 */
export type ServiceRouting = {
    services: Record<string, ServiceTarget>
    routes: ServiceRoutingNode
}

export type MatchedService = {
    name: string
    target: ServiceTarget
    auth: 'public' | 'required'
}
