/**
 * Durable Object gateway built on the WebSocket Hibernation API.
 *
 * The object may be evicted from memory while clients stay connected. The gateway id is the
 * Durable Object id, sockets carry their identity in an attachment and subscriptions live in
 * Durable Object storage, so a woken instance rebuilds the same registry.
 *
 *   export class RealtimeGateway implements DurableObject {
 *       readonly #gateway: HibernatableWebsocketGateway
 *       constructor(state: DurableObjectState) { this.#gateway = new HibernatableWebsocketGateway(state) }
 *       fetch(request: Request) { return this.#gateway.fetch(request) }
 *       webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) { this.#gateway.webSocketMessage(ws, message) }
 *       webSocketClose(ws: WebSocket) { this.#gateway.webSocketClose(ws) }
 *       webSocketError(ws: WebSocket) { this.#gateway.webSocketError(ws) }
 *   }
 *
 * Trust model: only the public Worker can reach the object. It authenticates the client, passes
 * the principal in `LIVEQUERY_PRINCIPAL_HEADER`, and registers subscriptions after an authorized
 * read. Clients may send `start` and `unsubscribe` for themselves; client `subscribe` frames are
 * dropped.
 */
import { decodeRealtimeFrame } from '../helpers/decodeRealtimeFrame.js'
import type { UpdatedData } from '../LivequeryBaseEntity.js'
import type { RealtimeSubscription } from '../LivequeryRealtime.js'
import { LIVEQUERY_PING_FRAME, LIVEQUERY_PONG_FRAME } from '../const.js'
import {
    WebsocketGatewayBase,
    type SocketLike,
    type WebsocketGatewayOptions,
} from '../WebsocketGatewayBase.js'
import {
    LIVEQUERY_DO_BROADCAST_PATH,
    LIVEQUERY_DO_SUBSCRIBE_PATH,
    LIVEQUERY_PRINCIPAL_HEADER,
    MAX_CLIENT_ID_LENGTH,
    SUBSCRIPTION_SWEEP_MS,
} from './const.js'
import type { DurableObjectStateLike, HibernatableWebSocket } from './types.js'

export type HibernatableWebsocketGatewayOptions = Pick<WebsocketGatewayOptions, 'disconnectGraceMs'>

type GatewaySocket = SocketLike & { principal?: string }

type SocketAttachment = { id?: string; principal?: string }

type SubscriptionRecord = RealtimeSubscription & { principal?: string }

type ClientFrame = { event?: unknown; data?: { ref?: unknown; refs?: unknown } }

declare class WebSocketPair {
    0: HibernatableWebSocket
    1: HibernatableWebSocket
}

declare class WebSocketRequestResponsePair {
    constructor(request: string, response: string)
}

const SUBSCRIPTION_PREFIX = 'sub:'
// When a disconnected client's subscriptions expire, as a Durable Object alarm time.
const EXPIRY_PREFIX = 'expire:'
const WEBSOCKET_OPEN = 1

function subscriptionKey(client_id: string, ref: string): string {
    return `${SUBSCRIPTION_PREFIX}${client_id}:${ref}`
}

function expiryKey(client_id: string): string {
    return `${EXPIRY_PREFIX}${client_id}`
}

function decodeFrame(raw: string | ArrayBuffer | ArrayBufferView): ClientFrame | undefined {
    try {
        const frame = decodeRealtimeFrame(raw)
        return typeof frame === 'object' && frame !== null ? frame as ClientFrame : undefined
    } catch {
        return undefined
    }
}

export class HibernatableWebsocketGateway extends WebsocketGatewayBase {
    /** Resolves once subscriptions and sockets from before hibernation are restored. */
    readonly ready: Promise<void>

    readonly #state: DurableObjectStateLike
    readonly #byWebSocket = new WeakMap<HibernatableWebSocket, GatewaySocket>()
    readonly #bySocket = new WeakMap<GatewaySocket, HibernatableWebSocket>()
    // Principal that owns each client id, so another principal cannot `start` with a leaked id.
    readonly #owners = new Map<string, string>()

    constructor(state: DurableObjectStateLike, options: HibernatableWebsocketGatewayOptions = {}) {
        // Keep clients on JSON: the runtime ping auto-response only matches the exact JSON ping frame.
        // Binary (msgpack) frames are still decoded if a client sends them.
        super({ ...options, id: state.id.toString(), binary: false })
        this.#state = state
        const Pair = (globalThis as { WebSocketRequestResponsePair?: typeof WebSocketRequestResponsePair })
            .WebSocketRequestResponsePair
        if (Pair) state.setWebSocketAutoResponse?.(new Pair(LIVEQUERY_PING_FRAME, LIVEQUERY_PONG_FRAME))
        this.ready = state.blockConcurrencyWhile(() => this.#restore())
    }

    /** Handle a WebSocket upgrade or one of the internal Worker → Durable Object calls. */
    async fetch(request: Request): Promise<Response> {
        await this.ready
        if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
            return this.handleRequest(request)
        }
        if (request.method !== 'POST') return new Response('Not found', { status: 404 })

        const { pathname } = new URL(request.url)
        if (pathname === LIVEQUERY_DO_BROADCAST_PATH) {
            this.next(await request.json() as UpdatedData)
            return new Response(null, { status: 204 })
        }
        if (pathname === LIVEQUERY_DO_SUBSCRIBE_PATH) {
            const subscription = await request.json() as RealtimeSubscription
            const principal = request.headers.get(LIVEQUERY_PRINCIPAL_HEADER) ?? undefined
            const accepted = this.register(subscription, principal)
            return new Response(null, { status: accepted ? 204 : 403 })
        }
        return new Response('Not found', { status: 404 })
    }

    /** Accept a WebSocket upgrade. The principal comes from `LIVEQUERY_PRINCIPAL_HEADER`. */
    handleRequest(request: Request): Response {
        if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
            return new Response('Expected WebSocket', { status: 426 })
        }
        const Pair = (globalThis as { WebSocketPair?: typeof WebSocketPair }).WebSocketPair
        if (!Pair) {
            return new Response('WebSocketPair not available in this runtime', { status: 500 })
        }

        const pair = new Pair()
        const server = pair[1]
        this.#state.acceptWebSocket(server)
        const principal = request.headers.get(LIVEQUERY_PRINCIPAL_HEADER) ?? undefined
        server.serializeAttachment({ principal } satisfies SocketAttachment)
        this.onConnection(this.#wrap(server))

        // `webSocket` is a Workers extension of ResponseInit that the DOM lib does not declare.
        return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit)
    }

    /**
     * Register a subscription for a client connected to this gateway. Returns false when the
     * subscription targets another gateway, the client is not connected here, or the client socket
     * was opened by a different principal.
     */
    register(subscription: RealtimeSubscription, principal?: string): boolean {
        const { ref, client_id, gateway_id } = subscription
        if (typeof ref !== 'string' || !ref || typeof client_id !== 'string') return false
        if (gateway_id !== this.id) return false
        const socket = this._connections.get(client_id) as GatewaySocket | undefined
        if (!socket || socket.gateway) return false
        if (socket.principal !== principal) return false
        this.listen([{ ref, client_id, gateway_id: this.id, listener_node_id: this.id }])
        return true
    }

    webSocketMessage(ws: HibernatableWebSocket, message: string | ArrayBuffer): void {
        this.onMessage(this.#wrap(ws), message)
    }

    webSocketClose(ws: HibernatableWebSocket): void {
        this.#drop(ws)
        try {
            ws.close()
        } catch { /* already closed by the runtime */ }
    }

    webSocketError(ws: HibernatableWebSocket): void {
        this.#drop(ws)
    }

    /**
     * Durable Object alarm handler. Detaches clients whose grace window has passed and sweeps
     * subscriptions whose socket never came back, then re-arms itself while any remain.
     */
    async alarm(): Promise<void> {
        await this.ready
        const now = Date.now()
        const expiries = await this.#state.storage.list<number>({ prefix: EXPIRY_PREFIX })
        const done: string[] = []
        let next: number | undefined

        for (const [key, at] of expiries) {
            const client_id = key.slice(EXPIRY_PREFIX.length)
            if (this._connections.has(client_id)) { done.push(key); continue }
            if (at > now) { next = next === undefined ? at : Math.min(next, at); continue }
            this.detach(client_id, this.#refsOf(client_id))
            done.push(key)
        }

        // A client that vanished while the object was evicted has no expiry record, so give it
        // one now; the next alarm removes it if it has not come back.
        for (const client_id of this.#orphanedClients()) {
            if (expiries.has(expiryKey(client_id))) continue
            const at = now + this._disconnectGraceMs
            await this.#state.storage.put(expiryKey(client_id), at)
            next = next === undefined ? at : Math.min(next, at)
        }

        if (done.length > 0) await this.#state.storage.delete(done)
        await this.#arm(next ?? (this._subscriptions.size > 0 ? now + SUBSCRIPTION_SWEEP_MS : undefined))
    }

    // ── Detach scheduling ──────────────────────────────────────────────────────
    // A Durable Object can be evicted mid-grace, which would drop a pending setTimeout and leave
    // the subscription in storage forever. Alarms survive eviction and let the object hibernate.

    protected override _scheduleDetach(client_id: string, _refs: string[]): void {
        const at = Date.now() + this._disconnectGraceMs
        this.#state.storage.put(expiryKey(client_id), at)
            .then(() => this.#arm(at))
            .catch(e => console.error('livequery: failed to schedule detach', e))
    }

    protected override _cancelDetach(client_id: string): boolean {
        // The alarm re-checks `_connections`, so a stale record is harmless; drop it anyway.
        this.#state.storage.delete([expiryKey(client_id)])
            .catch(e => console.error('livequery: failed to cancel detach', e))
        return this.#hasSubscriptions(client_id)
    }

    override onMessage(socket: SocketLike, raw: string | ArrayBuffer | ArrayBufferView): void {
        if (socket.gateway) {
            super.onMessage(socket, raw)
            return
        }
        const frame = decodeFrame(raw)
        if (frame?.event === 'start') {
            super.onMessage(socket, raw)
            return
        }
        if (frame?.event === 'unsubscribe' && socket.id) {
            // A client may only drop its own subscriptions, whatever client_id it sends.
            const ref = typeof frame.data?.ref === 'string' ? frame.data.ref : undefined
            const refs = Array.isArray(frame.data?.refs)
                ? frame.data.refs.filter((r): r is string => typeof r === 'string')
                : undefined
            this.unsubscribe_client(socket, { ref, refs, client_id: socket.id })
        }
        // Client `subscribe` frames are ignored: only the Worker registers subscriptions,
        // after the read they belong to has been authorized.
    }

    override listen(events: RealtimeSubscription[]): void {
        super.listen(events)
        for (const { ref, client_id } of events) {
            const meta = this._subscriptions.get(ref)?.get(client_id)
            if (!meta) continue
            const record: SubscriptionRecord = { ref, client_id, ...meta, principal: this.#owners.get(client_id) }
            this.#state.storage.put(subscriptionKey(client_id, ref), record)
                .catch(e => console.error('livequery: failed to persist subscription', e))
        }
    }

    override detach(client_id: string, refs: string | string[]): void {
        super.detach(client_id, refs)
        const removed = [refs].flat().filter(ref => !this._subscriptions.get(ref)?.has(client_id))
        if (removed.length > 0) {
            this.#state.storage.delete(removed.map(ref => subscriptionKey(client_id, ref)))
                .catch(e => console.error('livequery: failed to delete subscription', e))
        }
        if (!this._connections.has(client_id) && !this.#hasSubscriptions(client_id)) {
            this.#owners.delete(client_id)
        }
    }

    protected override _onStart(socket: SocketLike, data: { id: string; auth: string }): void {
        const gateway_socket = socket as GatewaySocket
        if (socket.id) return
        const id = data?.id
        if (typeof id !== 'string' || !id || id.length > MAX_CLIENT_ID_LENGTH) {
            socket.close()
            return
        }
        const owner = this.#owners.get(id)
        if (owner !== undefined && owner !== gateway_socket.principal) {
            socket.close()
            return
        }

        super._onStart(socket, data)
        if (!socket.id || socket.gateway) return

        if (gateway_socket.principal !== undefined) this.#owners.set(socket.id, gateway_socket.principal)
        const attachment: SocketAttachment = { id: socket.id, principal: gateway_socket.principal }
        this.#bySocket.get(gateway_socket)?.serializeAttachment(attachment)
    }

    // ── Internal ───────────────────────────────────────────────────────────────

    async #restore(): Promise<void> {
        const records = await this.#state.storage.list<SubscriptionRecord>({ prefix: SUBSCRIPTION_PREFIX })
        for (const { ref, client_id, gateway_id, listener_node_id, principal } of records.values()) {
            const map = this._subscriptions.get(ref) ?? new Map()
            map.set(client_id, { gateway_id, listener_node_id })
            this._subscriptions.set(ref, map)
            if (principal !== undefined) this.#owners.set(client_id, principal)
        }

        for (const ws of this.#state.getWebSockets()) this.#wrap(ws)

        // A client that dropped while the object was evicted lost its grace window with the old
        // instance. Give it a fresh one instead of detaching at once, so a client that is
        // reconnecting right now keeps its subscriptions.
        const orphans = this.#orphanedClients()
        if (orphans.size === 0) return
        const at = Date.now() + this._disconnectGraceMs
        for (const client_id of orphans) await this.#state.storage.put(expiryKey(client_id), at)
        await this.#arm(at)
    }

    /** Move the alarm earlier when needed; never push an existing one back. */
    async #arm(at: number | undefined): Promise<void> {
        if (at === undefined) return
        const current = await this.#state.storage.getAlarm()
        if (current !== null && current <= at) return
        await this.#state.storage.setAlarm(at)
    }

    #refsOf(client_id: string): string[] {
        return [...this._subscriptions]
            .filter(([, map]) => map.has(client_id))
            .map(([ref]) => ref)
    }

    #wrap(ws: HibernatableWebSocket): GatewaySocket {
        const existing = this.#byWebSocket.get(ws)
        if (existing) return existing

        const attachment = (ws.deserializeAttachment() ?? {}) as SocketAttachment
        const socket: GatewaySocket = {
            send: data => ws.send(data),
            close: () => ws.close(1000, 'closed'),
            isAlive: () => ws.readyState === WEBSOCKET_OPEN,
            id: attachment.id ?? '',
            gateway: false,
            refs: new Set<string>(),
            principal: attachment.principal,
        }
        this.#byWebSocket.set(ws, socket)
        this.#bySocket.set(socket, ws)
        this._sockets.add(socket)

        if (socket.id) {
            this._connections.set(socket.id, socket)
            for (const [ref, map] of this._subscriptions) {
                if (map.has(socket.id)) socket.refs.add(ref)
            }
        }
        return socket
    }

    #drop(ws: HibernatableWebSocket): void {
        const socket = this.#byWebSocket.get(ws) ?? this.#wrap(ws)
        this.onClose(socket)
        this.#byWebSocket.delete(ws)
    }

    #hasSubscriptions(client_id: string): boolean {
        for (const map of this._subscriptions.values()) {
            if (map.has(client_id)) return true
        }
        return false
    }

    #orphanedClients(): Set<string> {
        const orphans = new Set<string>()
        for (const map of this._subscriptions.values()) {
            for (const client_id of map.keys()) {
                if (!this._connections.has(client_id)) orphans.add(client_id)
            }
        }
        return orphans
    }

}
