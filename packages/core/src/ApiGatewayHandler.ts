import { randomUUID } from 'crypto'
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'http'
import { Subscription } from 'rxjs'
import {
    API_GATEWAY_NAMESPACE,
    LIVEQUERY_API_GATEWAY_DEBUG,
    LIVEQUERY_GATEWAY_TIMEOUT_MS,
    LIVEQUERY_MAGIC_KEY,
    WEBSOCKET_PATH,
} from './const.js'
import { UdpDiscovery, type UdpDiscoveryNode } from './UdpDiscovery.js'
import { WebsocketGateway } from './WebsocketGateway.js'
import { nodeRequestToWebRequest } from './helpers/nodeRequestToWebRequest.js'
import { writeWebResponse } from './helpers/writeWebResponse.js'

type RouteHost = {
    uri: string
    node_id: string
    offlineAt?: number
    // Why the host was isolated. 'ws' outranks 'http': it must persist until a WS
    // reconnect, whereas 'http' isolation clears on the next proof-of-life heartbeat.
    offlineReason?: 'ws' | 'http'
}

type RouteEntry = {
    hosts: RouteHost[]
    rr_index: number
}

type RoutingNode = {
    children: Record<string, RoutingNode>
    paramPrefixes: string[]
    methods: Record<string, RouteEntry>
}

export type RegisterOptions = {
    node_id: string
    hostname: string
    port: number
    paths: Array<{ method: string; path: string }>
}

export type ServiceApiMetadata = UdpDiscoveryNode & {
    role: 'service' | 'gateway'
    name: string
    port: number
    paths: Array<{ method: string; path: string }>
    linked: string[]
    target?: string
    ws?: { path: string; auth: string }
}

export type ServiceApiStatus = {
    id: string
    online: boolean
    metadata?: ServiceApiMetadata
} | { id: string; online: false }

export type ApiGatewayOptions = {
    ws?: WebsocketGateway
    discovery?: UdpDiscovery<ServiceApiMetadata>
    node_id?: string
    // Upstream-request timeout in ms. Defaults to LIVEQUERY_GATEWAY_TIMEOUT_MS
    // (env LIVEQUERY_GATEWAY_TIMEOUT in seconds, default 30s).
    timeoutMs?: number
}

function createNode(): RoutingNode {
    return { children: {}, paramPrefixes: [], methods: {} }
}

function normalizeSegment(seg: string): string {
    return seg.includes(':') ? seg.split(':')[0] + ':' : seg
}

function isSameServiceDefinition(a: ServiceApiMetadata, b: ServiceApiMetadata): boolean {
    return a.port === b.port
        && JSON.stringify(a.paths) === JSON.stringify(b.paths)
        && a.ws?.path === b.ws?.path
        && a.ws?.auth === b.ws?.auth
}

export class ApiGatewayHandler {
    readonly restGateway: this = this
    readonly #root: RoutingNode = createNode()
    readonly #nodeId: string
    readonly #timeoutMs: number
    readonly #lws?: WebsocketGateway
    readonly #discovery: UdpDiscovery<ServiceApiMetadata>
    readonly #discoverySubscription: Subscription
    readonly #services = new Map<string, {
        host: string
        metadata: ServiceApiMetadata
        subscription?: Subscription
    }>()
    #cleanupTimer: ReturnType<typeof setInterval> | undefined

    constructor(private options: ApiGatewayOptions) {
        this.#nodeId = options.node_id ?? randomUUID()
        this.#timeoutMs = options.timeoutMs ?? LIVEQUERY_GATEWAY_TIMEOUT_MS
        this.#lws = options.ws
        this.#discovery = options.discovery ?? new UdpDiscovery<ServiceApiMetadata>({ key: LIVEQUERY_MAGIC_KEY })

        this.#discoverySubscription = this.#discovery.subscribe(metadata => {
            if (metadata.role !== 'service') return
            if (metadata.namespace !== API_GATEWAY_NAMESPACE) return
            if (metadata.node_id === this.#nodeId) return

            const existing = this.#services.get(metadata.node_id)
            if (existing) {
                if (metadata.version <= existing.metadata.version) return
                if (isSameServiceDefinition(existing.metadata, metadata)) {
                    existing.metadata = { ...metadata, host: existing.host }
                    // A fresh heartbeat proves the process is alive → lift any
                    // HTTP-triggered isolation. WS isolation stays until reconnect.
                    this.#clearHttpOffline(metadata.node_id)
                    return
                }
                this.#removeService(metadata.node_id, false)
            }

            this.#join(metadata)
        })

        this.#discovery.broadcast(this.#metadata()).catch(e => console.error(e))

        this.#cleanupTimer = setInterval(() => this.#cleanupOfflineHosts(), 5000)
    }

    register({ node_id, hostname, port, paths }: RegisterOptions): void {
        const uri = `${hostname}:${port}`
        for (const { method, path } of paths) {
            const segments = path.split('/').filter(Boolean).map(normalizeSegment)
            let node = this.#root
            for (const seg of segments) {
                if (!node.children[seg]) node.children[seg] = createNode()
                if (seg !== ':' && seg.endsWith(':')) {
                    const prefix = seg.slice(0, -1)
                    if (!node.paramPrefixes.includes(prefix)) node.paramPrefixes.push(prefix)
                }
                node = node.children[seg]
            }

            const METHOD = method.toUpperCase()
            if (!node.methods[METHOD]) node.methods[METHOD] = { hosts: [], rr_index: 0 }
            const existing = node.methods[METHOD].hosts.find(h => h.node_id === node_id && h.uri === uri)
            if (existing) {
                existing.offlineAt = undefined  // host re-announced — back online
                existing.offlineReason = undefined
            } else {
                node.methods[METHOD].hosts.push({ node_id, uri })
            }
        }
    }

    deregister(node_id: string): void {
        const queue: RoutingNode[] = [this.#root]
        while (queue.length > 0) {
            const node = queue.shift()!
            for (const entry of Object.values(node.methods)) {
                entry.hosts = entry.hosts.filter(host => host.node_id !== node_id)
            }
            queue.push(...Object.values(node.children))
        }
    }

    fetch(request: Request): Promise<Response>
    fetch(
        req: IncomingMessage & { url: string; method: string; rawBody?: Buffer },
        res: ServerResponse,
        extraHeaders?: OutgoingHttpHeaders
    ): Promise<void>
    async fetch(
        requestOrReq: Request | IncomingMessage & { url: string; method: string; rawBody?: Buffer },
        res?: ServerResponse,
        extraHeaders?: OutgoingHttpHeaders
    ): Promise<Response | void> {
        if (requestOrReq instanceof Request) {

            const client_id = requestOrReq.headers.get('x-lcid') ?? requestOrReq.headers.get('socket_id')
            const extraHeaders: Record<string, string> = client_id && this.options.ws ? {
                'x-lcid': client_id,
                'x-lgid': requestOrReq.headers.get('x-lgid') || this.options.ws?.id || this.#nodeId,
            } : {}
            return this.#fetchRequest(
                requestOrReq,
                extraHeaders
            )
        }

        if (!res) throw new Error('ServerResponse is required for Node.js requests')
        const response = await this.#fetchRequest(
            nodeRequestToWebRequest(requestOrReq, extraHeaders),
            extraHeaders as HeadersInit | undefined
        )
        await writeWebResponse(res, response)
    }

    fetchRequest(request: Request): Promise<Response> {
        return this.fetch(request)
    }

    close(): void {
        clearInterval(this.#cleanupTimer)
        this.#discoverySubscription.unsubscribe()
        for (const { subscription } of this.#services.values()) {
            subscription?.unsubscribe()
        }
        this.#services.clear()
        this.#discovery.close()
    }

    async #fetchRequest(request: Request, extraHeaders?: HeadersInit): Promise<Response> {
        const url = new URL(request.url)
        const target = this.#resolve(url.pathname, request.method)

        if (target === undefined) {
            return Response.json({ error: { status: 404, code: 'API_NOT_FOUND', message: `No service registered for ${request.method} ${url.pathname}` } }, { status: 404 })
        }

        if (target === null) {
            return Response.json({ error: { status: 503, code: 'API_OFFLINE', message: `All hosts for ${request.method} ${url.pathname} are offline` } }, { status: 503 })
        }

        const headers = new Headers(request.headers)
        headers.delete('content-length')
        headers.delete('host')
        if (extraHeaders) {
            new Headers(extraHeaders).forEach((value, key) => headers.set(key, value))
        }

        const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body

        try {
            const response = await globalThis.fetch(`http://${target.uri}${url.pathname}${url.search}`, {
                method: request.method,
                headers,
                body,
                duplex: 'half',
                signal: AbortSignal.timeout(this.#timeoutMs),
            } as RequestInit)
            // The upstream answered → it is reachable. If we were still dialing it
            // while marked offline (e.g. a lone node we never stop calling), lift
            // the HTTP isolation now instead of waiting for the next heartbeat.
            if (target.offlineAt) this.#clearHttpOffline(target.node_id)
            return response
        } catch (err) {
            // Either a refused/failed connection OR the request blew the timeout (a
            // hung upstream that accepts the socket but never answers). Both mean the
            // whole service process is effectively unreachable — isolate EVERY route
            // it serves so subsequent requests to its other endpoints stop hitting it.
            this.#markNodeOffline(target.node_id, 'http')
            const name = (err as { name?: string } | undefined)?.name
            if (name === 'TimeoutError' || name === 'AbortError') {
                return Response.json({ error: { status: 504, code: 'SERVICE_API_TIMEOUT', message: `Upstream service at ${target.uri} did not respond within ${this.#timeoutMs}ms` } }, { status: 504 })
            }
            return Response.json({ error: { status: 502, code: 'SERVICE_API_OFFLINE', message: `Failed to reach upstream service at ${target.uri}` } }, { status: 502 })
        }
    }

    #matchChild(node: RoutingNode, segment: string): RoutingNode | undefined {
        if (node.children[segment]) return node.children[segment]
        for (const prefix of node.paramPrefixes) {
            if (segment.startsWith(prefix)) return node.children[prefix + ':']
        }
        return node.children[':']
    }

    #resolve(path: string, method: string): RouteHost | null | undefined {
        const segments = path.split('?')[0]!.split('/').filter(Boolean)
        let node: RoutingNode | undefined = this.#root
        for (const segment of segments) {
            node = this.#matchChild(node, segment)
            if (!node) return undefined
        }

        const entry = node.methods[method.toUpperCase()]
        if (!entry) return undefined
        if (entry.hosts.length === 0) return null

        // Prefer healthy hosts. If NONE are healthy, fall back to round-robin across
        // ALL registered hosts instead of hard-failing — an offline node is merely
        // "registered but currently unreachable" (it may be flapping/restarting), not
        // gone. There's no healthy alternative to protect anyway, so keep dialing them;
        // the first that answers recovers (a successful response clears its isolation).
        // A route only truly has nothing to serve it when its host list is empty (a node
        // fully leaves rotation via deregister — WS retries exhausted / discovery timeout),
        // which is the real 503 condition handled above.
        const online = entry.hosts.filter(h => !h.offlineAt)
        const pool = online.length > 0 ? online : entry.hosts
        const host = pool[entry.rr_index % pool.length]
        entry.rr_index++
        return host
    }

    #join(metadata: ServiceApiMetadata): void {
        const { port, node_id, name, paths, ws } = metadata
        const host = metadata.host ?? ''
        const subscription = ws
            ? this.#lws?.connect(
                `ws://${host}:${port}${ws.path}`,
                ws.auth,
                () => this.#markNodeOffline(node_id, 'ws'),
                () => this.#removeService(node_id, true),
                () => this.#markNodeOnline(node_id)
            )
            : undefined

        this.#services.set(node_id, { metadata, subscription, host })
        this.register({ node_id, hostname: host, port, paths: paths ?? [] })

        LIVEQUERY_API_GATEWAY_DEBUG && console.info(
            `[${new Date().toLocaleString()}] Service API online: ${name} at ${host}:${port}`
        )
    }

    #markNodeOffline(node_id: string, reason: 'ws' | 'http'): void {
        const now = Date.now()
        const queue: RoutingNode[] = [this.#root]
        while (queue.length > 0) {
            const node = queue.shift()!
            for (const entry of Object.values(node.methods)) {
                for (const host of entry.hosts) {
                    if (host.node_id !== node_id) continue
                    host.offlineAt = now
                    // 'ws' isolation outranks 'http': never let an http failure
                    // downgrade a node that's offline because its WS link dropped.
                    if (reason === 'ws' || host.offlineReason !== 'ws') host.offlineReason = reason
                }
            }
            queue.push(...Object.values(node.children))
        }
        LIVEQUERY_API_GATEWAY_DEBUG && console.warn(
            `[${new Date().toLocaleString()}] Service API offline (${reason}): ${node_id}`
        )
    }

    #markNodeOnline(node_id: string): void {
        const queue: RoutingNode[] = [this.#root]
        while (queue.length > 0) {
            const node = queue.shift()!
            for (const entry of Object.values(node.methods)) {
                for (const host of entry.hosts) {
                    if (host.node_id === node_id) {
                        host.offlineAt = undefined
                        host.offlineReason = undefined
                    }
                }
            }
            queue.push(...Object.values(node.children))
        }
        LIVEQUERY_API_GATEWAY_DEBUG && console.info(
            `[${new Date().toLocaleString()}] Service API back online: ${node_id}`
        )
    }

    // Lift only HTTP-triggered isolation (called when a fresh heartbeat proves the
    // process is alive). WS-triggered isolation is left untouched — only a real WS
    // reconnect (#markNodeOnline) may clear that.
    #clearHttpOffline(node_id: string): void {
        const queue: RoutingNode[] = [this.#root]
        while (queue.length > 0) {
            const node = queue.shift()!
            for (const entry of Object.values(node.methods)) {
                for (const host of entry.hosts) {
                    if (host.node_id === node_id && host.offlineReason === 'http') {
                        host.offlineAt = undefined
                        host.offlineReason = undefined
                    }
                }
            }
            queue.push(...Object.values(node.children))
        }
    }

    #cleanupOfflineHosts(): void {
        const deadline = Date.now() - 30_000
        const deadNodes = new Set<string>()
        const queue: RoutingNode[] = [this.#root]
        while (queue.length > 0) {
            const node = queue.shift()!
            for (const entry of Object.values(node.methods)) {
                for (const host of entry.hosts) {
                    if (!host.offlineAt || host.offlineAt > deadline) continue
                    const svc = this.#services.get(host.node_id)
                    // skip if WS reconnect is still in progress
                    if (svc?.subscription && !svc.subscription.closed) continue
                    deadNodes.add(host.node_id)
                }
            }
            queue.push(...Object.values(node.children))
        }
        for (const node_id of deadNodes) {
            this.#removeService(node_id, true)
        }
    }

    #removeService(id: string, logOffline: boolean): void {
        const service = this.#services.get(id)
        if (!service) return
        const { metadata: { name, port }, subscription, host } = service

        subscription?.unsubscribe()
        this.#services.delete(id)
        this.deregister(id)

        logOffline && LIVEQUERY_API_GATEWAY_DEBUG && console.error(
            `[${new Date().toLocaleString()}] Service API OFFLINE: ${name} at ${host}:${port}`
        )
    }

    #metadata(): ServiceApiMetadata {
        const metadata: ServiceApiMetadata = {
            name: 'API gateway',
            paths: [],
            port: 0,
            role: 'gateway',
            linked: [...this.#services.keys()],
            host: '',
            node_id: this.#nodeId,
            namespace: API_GATEWAY_NAMESPACE,
            version: Date.now(),
        }

        if (this.#lws) {
            metadata.ws = {
                auth: this.#lws.auth,
                path: WEBSOCKET_PATH,
            }
        }

        return metadata
    }
} 
