import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { BehaviorSubject, Observable, Subject, Subscriber } from 'rxjs'
import {
    OHAYO_API_GATEWAY,
    OHAYO_DISCOVERY_KEY,
    OHAYO_DISCOVERY_PORT,
} from './const.js'
import {
    containsAllTags,
    hasDiscoveryEnvelope,
    type Discovery,
    type DiscoveryEvent,
    type DiscoveryMessage,
    type DiscoveryOfflineData,
    type DiscoveryOptions,
} from './Discovery.js'

export type HttpDiscoveryStatus = 'not_ready' | 'ready' | 'closed'

export type HttpDiscoveryOptions = DiscoveryOptions & {
    key?: string
    port?: number
    gateways?: string[]
    listen?: boolean
    heartbeatMs?: number
    ttlMs?: number
    requestTimeoutMs?: number
}

type StoredNode<T> = {
    message: DiscoveryMessage<T>
    lastSeen: number
}

const DEFAULT_HEARTBEAT_MS = 10_000
const DEFAULT_TTL_MS = 35_000
const DEFAULT_REQUEST_TIMEOUT_MS = 2_000
const MAX_RETRY_ATTEMPTS = 5

export class HttpDiscovery<T> extends Observable<DiscoveryEvent<T>> implements Discovery<T> {
    readonly #events = new Subject<DiscoveryEvent<T>>()
    readonly #status$ = new BehaviorSubject<HttpDiscoveryStatus>('not_ready')
    readonly #nodes = new Map<string, StoredNode<T>>()
    readonly #options: Required<Pick<HttpDiscoveryOptions, 'namespace' | 'tags'>> & HttpDiscoveryOptions
    readonly #key: string
    readonly #gateways: string[]
    readonly #heartbeatMs: number
    readonly #ttlMs: number
    readonly #requestTimeoutMs: number
    readonly status$: Observable<HttpDiscoveryStatus> = this.#status$.asObservable()

    #server?: Server
    #heartbeatTimer?: ReturnType<typeof setInterval>
    #ttlTimer?: ReturnType<typeof setInterval>
    #lastMessage?: DiscoveryMessage<T>
    #closed = false

    constructor(options: HttpDiscoveryOptions) {
        super((subscriber: Subscriber<DiscoveryEvent<T>>) => this.#events.subscribe(subscriber))
        this.#options = options
        this.#key = options.key ?? OHAYO_DISCOVERY_KEY
        this.#gateways = (options.gateways ?? this.#envGateways()).map(gateway => this.#normalizeGateway(gateway)).filter(Boolean)
        this.#heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
        this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
        this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS

        if (options.listen ?? true) {
            this.#listen(options.port ?? OHAYO_DISCOVERY_PORT)
        } else {
            this.#status$.next('ready')
        }
    }

    get port(): number | undefined {
        const address = this.#server?.address()
        return typeof address === 'object' && address ? address.port : undefined
    }

    async broadcast(message: DiscoveryMessage<T>): Promise<void> {
        if (this.#closed) return
        const outbound = this.#validateOutbound(message)
        this.#lastMessage = outbound
        this.#startHeartbeat()
        await Promise.all(this.#gateways.map(gateway => this.#register(gateway, outbound, 0)))
    }

    close(): void {
        if (this.#closed) return
        this.#closed = true
        clearInterval(this.#heartbeatTimer)
        clearInterval(this.#ttlTimer)

        const message = this.#lastMessage
        if (message) {
            for (const gateway of this.#gateways) {
                this.#deregister(gateway, message.node_id).catch(() => {})
            }
        }

        this.#status$.next('closed')
        this.#events.complete()
        this.#status$.complete()
        this.#server?.close()
    }

    #listen(port: number): void {
        this.#server = createServer((req, res) => {
            this.#handle(req, res).catch(error => {
                this.#json(res, 500, { error: { message: String(error), code: 'INTERNAL_ERROR' } })
            })
        })
        this.#server.listen(port, () => {
            if (!this.#closed) this.#status$.next('ready')
        })
        this.#server.on('error', error => this.#events.error(error))
        this.#ttlTimer = setInterval(() => this.#expireNodes(), Math.max(50, Math.floor(this.#ttlMs / 3)))
        this.#ttlTimer.unref?.()
    }

    async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (req.method === 'GET' && url.pathname === '/health') {
            this.#json(res, 200, { ok: true })
            return
        }
        if (req.method === 'GET' && url.pathname === '/nodes') {
            if (!this.#authorized(req)) {
                this.#json(res, 401, { error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } })
                return
            }
            this.#json(res, 200, { nodes: [...this.#nodes.values()].map(node => node.message) })
            return
        }
        if (req.method === 'POST' && url.pathname === '/register') {
            if (!this.#authorized(req)) {
                this.#json(res, 401, { error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } })
                return
            }
            const body = await this.#readJson(req)
            if (!this.#validInbound(body)) {
                this.#json(res, 400, { error: { message: 'Invalid discovery message', code: 'INVALID_DISCOVERY_MESSAGE' } })
                return
            }
            this.#upsert(body, this.#remoteHost(req))
            this.#json(res, 204)
            return
        }
        if (req.method === 'DELETE' && url.pathname.startsWith('/register/')) {
            if (!this.#authorized(req)) {
                this.#json(res, 401, { error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } })
                return
            }
            const nodeId = decodeURIComponent(url.pathname.slice('/register/'.length))
            this.#remove(nodeId)
            this.#json(res, 204)
            return
        }
        this.#json(res, 404, { error: { message: 'Not found', code: 'NOT_FOUND' } })
    }

    #upsert(message: DiscoveryMessage<T>, remoteHost: string): void {
        const existing = this.#nodes.get(message.node_id)
        if (existing && message.seq <= existing.message.seq) {
            existing.lastSeen = Date.now()
            return
        }

        const enriched = { ...message, remote_host: remoteHost }
        this.#nodes.set(message.node_id, {
            message: enriched,
            lastSeen: Date.now(),
        })
        this.#events.next(enriched)
    }

    #remove(nodeId: string): void {
        const existing = this.#nodes.get(nodeId)
        if (!existing) return
        this.#nodes.delete(nodeId)
        this.#events.next(this.#offlineMessage(existing.message))
    }

    #expireNodes(): void {
        if (this.#closed) return
        const deadline = Date.now() - this.#ttlMs
        for (const [nodeId, node] of this.#nodes) {
            if (node.lastSeen > deadline) continue
            this.#nodes.delete(nodeId)
            this.#events.next(this.#offlineMessage(node.message))
        }
    }

    #offlineMessage(message: DiscoveryMessage<T>): DiscoveryMessage<DiscoveryOfflineData> {
        const now = Date.now()
        return {
            node_id: message.node_id,
            namespace: message.namespace,
            tags: message.tags,
            version: String(now),
            created_at: now,
            seq: message.seq + 1,
            data: { status: 'offline' },
            remote_host: message.remote_host,
        }
    }

    #validInbound(value: unknown): value is DiscoveryMessage<T> {
        if (!hasDiscoveryEnvelope<T>(value)) return false
        if (value.namespace !== this.#options.namespace) return false
        if (!containsAllTags(value.tags, this.#options.tags)) return false
        if (this.#options.node_id && value.node_id === this.#options.node_id) return false
        return true
    }

    #validateOutbound(message: DiscoveryMessage<T>): DiscoveryMessage<T> {
        if (!hasDiscoveryEnvelope<T>(message)) throw new Error('Invalid discovery message envelope')
        if (message.namespace !== this.#options.namespace) throw new Error(`Discovery message namespace must be ${this.#options.namespace}`)
        if (!containsAllTags(message.tags, this.#options.tags)) throw new Error(`Discovery message must contain tags: ${this.#options.tags.join(',')}`)
        if (this.#options.node_id && message.node_id !== this.#options.node_id) throw new Error(`Discovery message node_id must be ${this.#options.node_id}`)
        return message
    }

    #startHeartbeat(): void {
        if (this.#heartbeatTimer || this.#heartbeatMs <= 0 || this.#gateways.length === 0) return
        this.#heartbeatTimer = setInterval(() => {
            if (!this.#lastMessage || this.#closed) return
            this.#lastMessage = this.#bump(this.#lastMessage)
            for (const gateway of this.#gateways) {
                this.#register(gateway, this.#lastMessage, 0).catch(() => {})
            }
        }, this.#heartbeatMs)
        this.#heartbeatTimer.unref?.()
    }

    #bump(message: DiscoveryMessage<T>): DiscoveryMessage<T> {
        const now = Date.now()
        return {
            ...message,
            version: String(now),
            created_at: now,
            seq: message.seq + 1,
        }
    }

    async #register(gateway: string, message: DiscoveryMessage<T>, attempt: number): Promise<void> {
        try {
            const response = await fetch(`${gateway}/register`, {
                method: 'POST',
                headers: this.#headers(),
                body: JSON.stringify(message),
                signal: AbortSignal.timeout(this.#requestTimeoutMs),
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
        } catch (error) {
            this.#scheduleRetry(gateway, message, attempt, error)
        }
    }

    async #deregister(gateway: string, nodeId: string): Promise<void> {
        await fetch(`${gateway}/register/${encodeURIComponent(nodeId)}`, {
            method: 'DELETE',
            headers: this.#headers(),
            signal: AbortSignal.timeout(this.#requestTimeoutMs),
        })
    }

    #scheduleRetry(gateway: string, message: DiscoveryMessage<T>, attempt: number, error: unknown): void {
        if (this.#closed || attempt >= MAX_RETRY_ATTEMPTS) {
            if (!this.#closed) console.error(error)
            return
        }
        const delay = Math.min(30_000, 250 * 2 ** attempt)
        const timer = setTimeout(() => this.#register(gateway, this.#bump(message), attempt + 1).catch(() => {}), delay)
        timer.unref?.()
    }

    #headers(): HeadersInit {
        return {
            authorization: `Bearer ${this.#key}`,
            'content-type': 'application/json',
        }
    }

    #authorized(req: IncomingMessage): boolean {
        if (!this.#key) return true
        return req.headers.authorization === `Bearer ${this.#key}`
    }

    async #readJson(req: IncomingMessage): Promise<unknown> {
        const chunks: Buffer[] = []
        for await (const chunk of req) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        }
        if (chunks.length === 0) return undefined
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    }

    #json(res: ServerResponse, status: number, body?: unknown): void {
        res.statusCode = status
        if (body === undefined) {
            res.end()
            return
        }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(body))
    }

    #remoteHost(req: IncomingMessage): string {
        return (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '') || '127.0.0.1'
    }

    #envGateways(): string[] {
        return OHAYO_API_GATEWAY.split(',').map(item => item.trim()).filter(Boolean)
    }

    #normalizeGateway(gateway: string): string {
        const withProtocol = /^https?:\/\//.test(gateway) ? gateway : `http://${gateway}`
        return withProtocol.replace(/\/+$/, '')
    }
}

