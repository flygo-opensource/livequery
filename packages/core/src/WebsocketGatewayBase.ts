/**
 * Runtime-agnostic WebSocket gateway protocol.
 *
 * Contains all the subscription routing, gateway-to-gateway handshake, and
 * sync event format. Has NO runtime imports (no `ws`, no Bun, no `http`).
 *
 * Concrete adapters extend this class and provide:
 *   - A way to accept incoming connections (e.g. ws.WebSocketServer, Bun.serve,
 *     WebSocketPair on the edge).
 *   - For each accepted socket, call `onConnection(socket)` then forward
 *     `'message'` events to `onMessage(socket, raw)` and `'close'` events to
 *     `onClose(socket)`.
 *   - A way to dispose of the transport in `close()`.
 *
 * See `WebsocketGateway` (Node, default export), `BunWebsocketGateway`, and
 * `EdgeWebsocketGateway` for the bundled adapters.
 */
import {
    Subject, Observable, Subscription, BehaviorSubject,
    of, fromEvent, merge, EMPTY, timer,
} from 'rxjs'
import {
    tap, map, switchMap, filter, finalize, mergeAll, retry, takeWhile,
} from 'rxjs/operators'
import { UpdatedData, LivequeryBaseEntity } from '@livequery/types'
import { LIVEQUERY_API_GATEWAY_DEBUG } from './const.js'
import { LivequeryContext, LivequeryHandler } from './LivequeryContext.js'


// ─── Event types ──────────────────────────────────────────────────────────────

export type RealtimeSubscription = {
    ref: string,
    client_id: string
    gateway_id: string
    listener_node_id: string
}

type HelloEvent = { event: 'hello'; gid: string, binary: boolean }
type StartEvent = { event: 'start'; data: { id: string; auth: string } }
type SubscribeEvent = { event: 'subscribe' } & RealtimeSubscription
type UnsubscribeEvent = { event: 'unsubscribe'; data: { ref?: string; refs?: string[]; client_id: string } }
type SyncEvent = { event: 'sync'; cids: string[]; data?: { changes: UpdatedData[] } }
type AnyEvent = HelloEvent | StartEvent | SubscribeEvent | UnsubscribeEvent | SyncEvent

type SubscriptionMeta = { gateway_id: string; listener_node_id: string }

type GatewayId = string
type ClientId = string
type Ref = string

const ENDPOINT_RESTARTED = 'ENDPOINT_RESTARTED'

/**
 * Minimal contract an adapter wraps each accepted WebSocket into. The adapter
 * owns the underlying socket; this gateway only calls `.send()`, `.close()`,
 * and mutates the identity fields after the client `start` handshake.
 */
export interface SocketLike {
    send(data: string): void
    close(): void
    id: string
    gateway: boolean
    refs: Set<string>
}

function randomId(): string {
    const g = globalThis as { crypto?: { randomUUID?: () => string } }
    if (g.crypto?.randomUUID) return g.crypto.randomUUID()
    // Fallback for older runtimes — sufficient uniqueness for gateway/auth ids.
    return Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 10)).join('-')
}


// ─── Gateway protocol ─────────────────────────────────────────────────────────

export class WebsocketGatewayBase extends Subject<UpdatedData> implements LivequeryHandler {

    protected readonly _connections = new Map<GatewayId | ClientId, SocketLike>()
    protected readonly _sockets = new Set<SocketLike>()
    protected readonly _subscriptions = new Map<Ref, Map<ClientId, SubscriptionMeta>>()
    protected readonly _pipes = new Map<Ref, { o: Observable<any>; s: Subscription }>()
    protected readonly _updatesSubscription: Subscription
    protected _closed = false

    public readonly id = randomId()
    public readonly auth = randomId()

    constructor() {
        super()

        // Broadcast UpdatedData to all subscribed sockets
        this._updatesSubscription = this.subscribe(({ ref, data, type }) => {
            if (this._closed) return
            const targets = new Map<string, { socket: SocketLike; cids: string[] }>()

            for (const map of [this._subscriptions.get(ref), this._subscriptions.get(`${ref}/${data.id}`)]) {
                if (!map) continue
                for (const [client_id, { gateway_id, listener_node_id }] of map) {
                    const conn_id = gateway_id === this.id
                        ? listener_node_id === this.id ? client_id : listener_node_id
                        : gateway_id
                    const prev = targets.get(conn_id)
                    const socket = prev?.socket ?? this._connections.get(conn_id)
                    if (!socket) continue
                    if (prev) {
                        prev.cids.push(client_id)
                    } else {
                        targets.set(conn_id, { socket, cids: [client_id] })
                    }
                }
            }

            for (const [, { socket, cids }] of targets) {
                // `id` is mirrored at the top of the change object for FE
                // convenience — the UpdatedData type only carries it inside
                // `data`, but consumers commonly want it at the change level.
                const change = { ref, data, type, id: data?.id } as UpdatedData & { id?: string }
                const event: SyncEvent = { event: 'sync', cids, data: { changes: [change] } }
                socket.send(JSON.stringify(event))
            }
        })
    }

    // ── Adapter hooks ──────────────────────────────────────────────────────────
    // Adapters call these three methods to drive the protocol.

    /** Register a newly accepted WebSocket. */
    onConnection(socket: SocketLike): void {
        if (this._closed) { socket.close(); return }
        this._sockets.add(socket)
    }

    /** Forward a frame received from the wire into the protocol. */
    onMessage(socket: SocketLike, raw: string | Buffer | ArrayBuffer): void {
        if (this._closed) return
        try {
            const text = typeof raw === 'string'
                ? raw
                : raw instanceof ArrayBuffer
                    ? new TextDecoder().decode(raw)
                    : raw.toString()
            const msg = JSON.parse(text) as AnyEvent
            if (msg.event === 'start') this._onStart(socket, msg.data)
            else if (msg.event === 'unsubscribe') this.unsubscribe_client(socket, msg.data)
            else if (msg.event === 'subscribe') this.listen([msg])
        } catch { /* malformed message, ignore */ }
    }

    /** Adapter notifies that the underlying socket has closed. */
    onClose(socket: SocketLike): void {
        this._onDisconnect(socket)
    }

    // ── Internal socket lifecycle ──────────────────────────────────────────────

    protected _onStart(socket: SocketLike, { id, auth }: { id: string; auth: string }): void {
        if (socket.id) return
        if (auth && auth !== this.auth) { socket.close(); return }
        if (this._connections.has(id)) { socket.close(); return }

        socket.id = id
        socket.gateway = auth === this.auth
        socket.refs = new Set()
        this._connections.set(id, socket)

        const hello: HelloEvent = { event: 'hello', gid: this.id, binary: true }
        socket.send(JSON.stringify(hello))
    }

    protected _onDisconnect(socket: SocketLike): void {
        this._sockets.delete(socket)
        if (!socket.id) return
        if (this._closed) {
            this._connections.delete(socket.id)
            return
        }

        if (socket.gateway) {
            for (const [ref, map] of this._subscriptions) {
                for (const [client_id, { gateway_id }] of map) {
                    if (gateway_id === socket.id) map.delete(client_id)
                }
                if (map.size === 0) {
                    this._pipes.get(ref)?.s.unsubscribe()
                    this._subscriptions.delete(ref)
                }
            }
        } else {
            const refs = [...socket.refs ?? []]
            if (refs.length > 0) this.unsubscribe_client(socket, { refs, client_id: socket.id })
        }

        this._connections.delete(socket.id)
    }

    // ── Public protocol API ────────────────────────────────────────────────────

    handle(ctx: LivequeryContext): void {
        if (!ctx.livequery) return
        const clientId = ctx.request.headers.get('x-lcid') ?? ctx.request.headers.get('socket_id')
        const targetGatewayId = ctx.request.headers.get('x-lgid') ?? this.id
        if (!clientId || !targetGatewayId) return undefined

        this.listen([{
            ref: ctx.livequery.ref,
            client_id: clientId,
            gateway_id: targetGatewayId,
            listener_node_id: this.id
        }])
    }

    listen(events: RealtimeSubscription[]): void {
        if (this._closed) return

        for (const { ref, client_id, gateway_id, listener_node_id } of events) {
            if (client_id === gateway_id) continue

            const socket = this._connections.get(client_id)
            if (gateway_id === this.id && !socket && listener_node_id === this.id) {
                continue
            }

            if (gateway_id === this.id && socket?.refs?.has(ref)) {
                if (listener_node_id !== this.id) {
                    const target = this._connections.get(listener_node_id)
                    if (target) {
                        const ev: UnsubscribeEvent = { event: 'unsubscribe', data: { client_id, ref } }
                        target.send(JSON.stringify(ev))
                    }
                }
                continue
            }

            const map = this._subscriptions.get(ref) ?? new Map<ClientId, SubscriptionMeta>()
            if (map.has(client_id)) continue
            map.set(client_id, { gateway_id, listener_node_id })
            this._subscriptions.set(ref, map)
            socket?.refs?.add(ref)

            if (gateway_id !== this.id) {
                const target = this._connections.get(gateway_id)
                if (target) {
                    const ev: SubscribeEvent = { event: 'subscribe', client_id, gateway_id, ref, listener_node_id }
                    target.send(JSON.stringify(ev))
                }
            }
        }
    }

    unsubscribe_client(socket: SocketLike, body: { ref?: string; refs?: string[]; client_id?: string }): void {
        if (this._closed) return
        const client_id = body.client_id ?? socket.id
        const refs = [...body.ref ? [body.ref] : [], ...body.refs ?? []]
        this.detach(client_id, refs)
    }

    detach(client_id: string, refs: string | string[]): void {
        if (this._closed) return
        for (const ref of [refs].flat()) {
            const map = this._subscriptions.get(ref)
            if (!map) continue
            const routing = map.get(client_id)
            map.delete(client_id)

            if (map.size === 0) {
                this._pipes.get(ref)?.s.unsubscribe()
                this._subscriptions.delete(ref)
            }

            this._connections.get(client_id)?.refs?.delete(ref)

            const listener_node_id = routing?.listener_node_id
            if (listener_node_id && listener_node_id !== this.id) {
                const gateway = this._connections.get(listener_node_id)
                if (gateway) {
                    const ev: UnsubscribeEvent = { event: 'unsubscribe', data: { ref, client_id } }
                    gateway.send(JSON.stringify(ev))
                }
            }
        }
    }

    async link<T extends LivequeryBaseEntity>(
        ref: string,
        handler: (o?: Observable<UpdatedData<T>>) => Promise<Observable<UpdatedData<T>>> | Observable<UpdatedData<T>> | undefined | void
    ): Promise<void> {
        if (this._closed) return
        if (!this._subscriptions.has(ref)) return
        const m = this._pipes.get(ref)
        const merged = handler(m?.o)
        const o = merged instanceof Promise ? await merged : merged
        if (!o || o === m?.o) return
        m?.s.unsubscribe()
        this._pipes.set(ref, {
            o,
            s: o.pipe(finalize(() => this._pipes.delete(ref))).subscribe(data => this.next(data))
        })
    }

    /**
     * Outbound connection to another gateway node with auto-retry.
     *
     * Uses `globalThis.WebSocket` (available on Node 22+, Bun, Deno, browsers,
     * Cloudflare Workers, etc.). For older Node runtimes, polyfill via
     *   `(globalThis as any).WebSocket = require('ws').WebSocket`.
     */
    connect(url: string, auth: string, onoffline?: () => void, ondone?: () => void, onreconnect?: () => void): Subscription {
        if (this._closed) return new Subscription()

        const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket
        if (!WS) {
            throw new Error('connect() requires a global WebSocket. On Node < 22, polyfill via: (globalThis as any).WebSocket = require("ws").WebSocket')
        }

        const gateway$ = new BehaviorSubject({ id: '', stop: false })
        let everConnected = false

        return of(0).pipe(
            takeWhile(() => !gateway$.getValue().stop),
            map(() => new WS(url)),
            switchMap((ws) => merge(
                fromEvent(ws, 'open').pipe(tap(() => {
                    const ev: StartEvent = { event: 'start', data: { id: this.id, auth } }
                    ws.send(JSON.stringify(ev))
                })),
                fromEvent(ws, 'close').pipe(map(() => { throw 'CLOSED' })),
                fromEvent(ws, 'error').pipe(map(e => { throw e })),
                fromEvent<MessageEvent | { data: string | Buffer }>(ws, 'message').pipe(
                    map((e: any) => {
                        const data = (e?.data ?? e) as string | Buffer
                        const text = typeof data === 'string' ? data : data.toString()
                        const parsed = JSON.parse(text) as AnyEvent

                        if (parsed.event === 'hello') {
                            const old_id = gateway$.getValue().id
                            if (old_id === '') {
                                everConnected = true
                                gateway$.next({ id: parsed.gid, stop: false })
                            } else if (old_id !== parsed.gid) {
                                gateway$.next({ id: parsed.gid, stop: true })
                                throw ENDPOINT_RESTARTED
                            } else {
                                everConnected = true
                                onreconnect?.()
                            }
                            // Wrap the outbound socket into the SocketLike contract
                            const socket: SocketLike = {
                                send: (d) => ws.send(d),
                                close: () => ws.close(),
                                id: parsed.gid,
                                gateway: true,
                                refs: new Set<string>(),
                            }
                            this._connections.set(parsed.gid, socket)
                            return null
                        }

                        if (parsed.event === 'subscribe') {
                            this.listen([parsed])
                            return null
                        }

                        return parsed as SyncEvent
                    }),
                    filter(Boolean),
                    map(({ cids, data }) => cids.map(client_id => ({ event: 'sync', data, client_id }))),
                    mergeAll(),
                    tap(({ client_id, ...event }: any) => {
                        this._connections.get(client_id)?.send(JSON.stringify(event))
                    })
                )
            ).pipe(
                finalize(() => {
                    if (everConnected) {
                        everConnected = false
                        onoffline?.()
                    }
                })
            )),
            retry({
                resetOnSuccess: true,
                delay: (e, n) => {
                    if (e === ENDPOINT_RESTARTED) return EMPTY
                    if (n >= 3) {
                        console.error(`[livequery] Gateway connection to ${url} failed after ${n} consecutive retries, giving up.`)
                        return EMPTY
                    }
                    return timer(1000)
                }
            }),
            finalize(() => ondone?.())
        ).subscribe()
    }

    close(): void {
        if (this._closed) return
        this._closed = true
        this._updatesSubscription.unsubscribe()

        for (const pipe of this._pipes.values()) {
            pipe.s.unsubscribe()
        }

        for (const socket of this._sockets) {
            socket.close()
        }

        this._sockets.clear()
        this._connections.clear()
        this._subscriptions.clear()
        this._pipes.clear()

        this.complete()
    }
}
