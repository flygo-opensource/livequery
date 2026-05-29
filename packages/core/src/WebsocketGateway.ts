import { WebSocket, WebSocketServer } from 'ws'
import * as http from 'http'
import {
    Subject, Observable, Subscription, BehaviorSubject,
    of, fromEvent, merge, EMPTY, timer,
} from 'rxjs'
import {
    tap, map, switchMap, filter, finalize, mergeAll, retry, takeWhile,
} from 'rxjs/operators'
import { UpdatedData, LivequeryBaseEntity } from '@livequery/types'
import { randomUUID } from 'crypto'
import { LIVEQUERY_API_GATEWAY_DEBUG, WEBSOCKET_PATH } from './const.js'
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

// ─── Socket abstraction ───────────────────────────────────────────────────────
// Uniform interface for both ws-package sockets and Bun native ServerWebSocket

type SocketMeta = {
    send(data: string): void
    close(): void
    on(event: 'message', h: (raw: string | Buffer) => void): void
    on(event: 'close' | 'error', h: (e?: unknown) => void): void
    id: string
    gateway: boolean
    refs: Set<string>
}

// Data stored inside each Bun ServerWebSocket
type BunSocketData = {
    id: string
    gateway: boolean
    refs: Set<string>
    // per-socket event handlers, filled in by SocketMeta.on()
    _on: { msg?: (raw: string | Buffer) => void; close?: () => void }
}

type SubscriptionMeta = { gateway_id: string; listener_node_id: string }

type GatewayId = string
type ClientId = string
type Ref = string
type BunServer = { stop(closeActiveConnections?: boolean): void }
const HTTP_SERVER_GATEWAYS = Symbol.for('livequery.websocket_gateways')
const HTTP_SERVER_CLOSE_PATCHED = Symbol.for('livequery.websocket_close_patched')

const isBun = typeof (globalThis as any).Bun !== 'undefined'
const ENDPOINT_RESTARTED = 'ENDPOINT_RESTARTED'

// ─── Gateway ──────────────────────────────────────────────────────────────────

export class WebsocketGateway extends Subject<UpdatedData> implements LivequeryHandler {

    readonly #connections = new Map<GatewayId | ClientId, SocketMeta>()
    readonly #sockets = new Set<SocketMeta>()
    readonly #subscriptions = new Map<Ref, Map<ClientId, SubscriptionMeta>>()
    readonly #pipes = new Map<Ref, { o: Observable<any>; s: Subscription }>()
    readonly #updatesSubscription: Subscription
    #server?: WebSocketServer | BunServer
    #httpServer?: http.Server
    #closed = false

    public readonly id = randomUUID()
    public readonly auth = randomUUID()

    /**
     * @param server  http.Server  — Node.js mode (uses `ws` package)
     *                number       — Bun mode: port for Bun.serve() (requires Bun runtime)
     */
    constructor(server: http.Server | number) {
        super()

        if (typeof server === 'number') {
            if (!isBun) throw new Error('Passing a port number requires Bun runtime')
            this.#startBun(server)
        } else {
            this.#startNode(server)
        }

        // Broadcast UpdatedData to all subscribed sockets
        this.#updatesSubscription = this.subscribe(({ ref, data, type }) => {
            if (this.#closed) return
            const targets = new Map<string, { socket: SocketMeta; cids: string[] }>()

            for (const map of [this.#subscriptions.get(ref), this.#subscriptions.get(`${ref}/${data.id}`)]) {
                if (!map) continue
                for (const [client_id, { gateway_id, listener_node_id }] of map) {
                    const conn_id = gateway_id === this.id
                        ? listener_node_id === this.id ? client_id : listener_node_id
                        : gateway_id
                    const prev = targets.get(conn_id)
                    const socket = prev?.socket ?? this.#connections.get(conn_id)
                    if (!socket) continue
                    if (prev) {
                        prev.cids.push(client_id)
                    } else {
                        targets.set(conn_id, { socket, cids: [client_id] })
                    }
                }
            }

            for (const [, { socket, cids }] of targets) {
                const event: SyncEvent = { event: 'sync', cids, data: { changes: [{ ref, data, type }] } }
                socket.send(JSON.stringify(event))
            }
        })
    }

    // ── Backend init ───────────────────────────────────────────────────────────

    #startNode(server: http.Server) {
        const wss = new WebSocketServer({ server, path: WEBSOCKET_PATH })
        this.#server = wss
        this.#httpServer = server
        this.#patchHttpServerClose(server)
        wss.on('connection', (ws) => {
            // Attach metadata directly onto the ws object (standard EventEmitter pattern)
            const socket = Object.assign(ws, {
                id: '', gateway: false, refs: new Set<string>()
            }) as unknown as SocketMeta
            this.#onConnection(socket)
        })
    }

    #startBun(port: number) {
        const self = this
        const Bun = (globalThis as any).Bun

        this.#server = Bun.serve({
            port,

            // HTTP side: only upgrade WebSocket path, reject everything else
            fetch(req: Request, server: any) {
                if (new URL(req.url).pathname === WEBSOCKET_PATH) {
                    const ok = server.upgrade(req, {
                        data: {
                            id: '', gateway: false,
                            refs: new Set<string>(),
                            _on: {},
                        } satisfies BunSocketData,
                    })
                    if (ok) return
                }
                return new Response('Not found', { status: 404 })
            },

            websocket: {
                // Build a SocketMeta wrapper whose property access delegates to ws.data,
                // and whose .on() stores handlers there for the global dispatchers below.
                open(ws: any) {
                    const socket: SocketMeta = {
                        send: (d) => ws.send(d),
                        close: () => ws.close(),
                        on(event: string, h: any) {
                            if (event === 'message') ws.data._on.msg = h
                            else ws.data._on.close = h   // 'close' and 'error'
                        },
                        get id() { return ws.data.id },
                        set id(v) { ws.data.id = v },
                        get gateway() { return ws.data.gateway },
                        set gateway(v) { ws.data.gateway = v },
                        get refs() { return ws.data.refs },
                        set refs(v) { ws.data.refs = v },
                    }
                    self.#onConnection(socket)
                },
                message(ws: any, data: string | Buffer) { ws.data._on.msg?.(data) },
                close(ws: any) { ws.data._on.close?.() },
                error(ws: any) { ws.data._on.close?.() },
            },
        })
    }

    #patchHttpServerClose(server: http.Server): void {
        const target = server as http.Server & {
            [HTTP_SERVER_GATEWAYS]?: Set<WebsocketGateway>
            [HTTP_SERVER_CLOSE_PATCHED]?: boolean
        }
        const gateways = target[HTTP_SERVER_GATEWAYS] ?? new Set<WebsocketGateway>()
        gateways.add(this)
        target[HTTP_SERVER_GATEWAYS] = gateways

        if (target[HTTP_SERVER_CLOSE_PATCHED]) return

        const close = server.close.bind(server)
        target.close = ((...args: Parameters<http.Server['close']>) => {
            for (const gateway of gateways) {
                gateway.close()
            }
            server.closeAllConnections?.()
            return close(...args)
        }) as http.Server['close']
        target[HTTP_SERVER_CLOSE_PATCHED] = true
    }

    // ── Internal socket lifecycle ──────────────────────────────────────────────

    #onConnection(socket: SocketMeta) {
        if (this.#closed) {
            socket.close()
            return
        }

        this.#sockets.add(socket)
        socket.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw.toString()) as AnyEvent
                if (msg.event === 'start') this.#onStart(socket, msg.data)
                if (msg.event === 'unsubscribe') this.unsubscribe_client(socket, msg.data)
                if (msg.event === 'subscribe') this.listen([msg])
            } catch { /* malformed message, ignore */ }
        })
        socket.on('close', () => this.#onDisconnect(socket))
        socket.on('error', (e) => {
            LIVEQUERY_API_GATEWAY_DEBUG && console.error('[livequery] Socket error:', e)
            this.#onDisconnect(socket)
        })
    }

    #onStart(socket: SocketMeta, { id, auth }: { id: string; auth: string }) {
        if (socket.id) return
        if (auth && auth !== this.auth) { socket.close(); return }
        if (this.#connections.has(id)) { socket.close(); return }

        socket.id = id
        socket.gateway = auth === this.auth
        socket.refs = new Set()
        this.#connections.set(id, socket)

        const hello: HelloEvent = { event: 'hello', gid: this.id, binary: true }
        socket.send(JSON.stringify(hello))
    }

    #onDisconnect(socket: SocketMeta) {
        this.#sockets.delete(socket)
        if (!socket.id) return
        if (this.#closed) {
            this.#connections.delete(socket.id)
            return
        }

        if (socket.gateway) {
            for (const [ref, map] of this.#subscriptions) {
                for (const [client_id, { gateway_id }] of map) {
                    if (gateway_id === socket.id) map.delete(client_id)
                }
                if (map.size === 0) {
                    this.#pipes.get(ref)?.s.unsubscribe()
                    this.#subscriptions.delete(ref)
                }
            }
        } else {
            const refs = [...socket.refs ?? []]
            if (refs.length > 0) this.unsubscribe_client(socket, { refs, client_id: socket.id })
        }

        this.#connections.delete(socket.id)
    }

    // ── Public API ─────────────────────────────────────────────────────────────
    handle(ctx: LivequeryContext) {
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


    listen(events: RealtimeSubscription[]) {
        if (this.#closed) return

        for (const { ref, client_id, gateway_id, listener_node_id } of events) {
            if (client_id === gateway_id) continue

            const socket = this.#connections.get(client_id)
            if (gateway_id === this.id && !socket && listener_node_id === this.id) {
                continue
            }

            if (gateway_id === this.id && socket?.refs?.has(ref)) {
                if (listener_node_id !== this.id) {
                    const target = this.#connections.get(listener_node_id)
                    if (target) {
                        const ev: UnsubscribeEvent = { event: 'unsubscribe', data: { client_id, ref } }
                        target.send(JSON.stringify(ev))
                    }
                }
                continue
            }

            const map = this.#subscriptions.get(ref) ?? new Map<ClientId, SubscriptionMeta>()
            if (map.has(client_id)) continue
            map.set(client_id, { gateway_id, listener_node_id })
            this.#subscriptions.set(ref, map)
            socket?.refs?.add(ref)

            if (gateway_id !== this.id) {
                const target = this.#connections.get(gateway_id)
                if (target) {
                    const ev: SubscribeEvent = { event: 'subscribe', client_id, gateway_id, ref, listener_node_id }
                    target.send(JSON.stringify(ev))
                }
            }
        }
    }

    unsubscribe_client(socket: SocketMeta, body: { ref?: string; refs?: string[]; client_id?: string }) {
        if (this.#closed) return

        const client_id = body.client_id ?? socket.id
        const refs = [...body.ref ? [body.ref] : [], ...body.refs ?? []]
        this.detach(client_id, refs)
    }

    detach(client_id: string, refs: string | string[]) {
        if (this.#closed) return
        for (const ref of [refs].flat()) {
            const map = this.#subscriptions.get(ref)
            if (!map) continue
            const routing = map.get(client_id)
            map.delete(client_id)

            if (map.size === 0) {
                this.#pipes.get(ref)?.s.unsubscribe()
                this.#subscriptions.delete(ref)
            }

            this.#connections.get(client_id)?.refs?.delete(ref)

            const listener_node_id = routing?.listener_node_id
            if (listener_node_id && listener_node_id !== this.id) {
                const gateway = this.#connections.get(listener_node_id)
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
    ) {
        if (this.#closed) return
        if (!this.#subscriptions.has(ref)) return
        const m = this.#pipes.get(ref)
        const merged = handler(m?.o)
        const o = merged instanceof Promise ? await merged : merged
        if (!o || o === m?.o) return
        m?.s.unsubscribe()
        this.#pipes.set(ref, {
            o,
            s: o.pipe(finalize(() => this.#pipes.delete(ref))).subscribe(data => this.next(data))
        })
    }

    // Connect outbound to another gateway node with auto-retry
    connect(url: string, auth: string, onoffline?: () => void, ondone?: () => void, onreconnect?: () => void): Subscription {
        if (this.#closed) return new Subscription()

        const gateway$ = new BehaviorSubject({ id: '', stop: false })
        let everConnected = false

        return of(0).pipe(
            takeWhile(() => !gateway$.getValue().stop),
            map(() => new WebSocket(url)),
            switchMap((ws) => merge(
                fromEvent(ws, 'open').pipe(tap(() => {
                    const ev: StartEvent = { event: 'start', data: { id: this.id, auth } }
                    ws.send(JSON.stringify(ev))
                })),
                fromEvent(ws, 'close').pipe(map(() => { throw 'CLOSED' })),
                fromEvent(ws, 'error').pipe(map(e => { throw e })),
                fromEvent<{ data: string }>(ws, 'message').pipe(
                    map(({ data }) => {
                        const parsed = JSON.parse(data.toString()) as AnyEvent

                        if (parsed.event === 'hello') {
                            const old_id = gateway$.getValue().id
                            if (old_id === '') {
                                everConnected = true
                                gateway$.next({ id: parsed.gid, stop: false })
                            } else if (old_id !== parsed.gid) {
                                gateway$.next({ id: parsed.gid, stop: true })
                                throw ENDPOINT_RESTARTED
                            } else {
                                // same gateway ID — reconnected after a drop
                                everConnected = true
                                onreconnect?.()
                            }
                            this.#connections.set(parsed.gid,
                                Object.assign(ws, { id: parsed.gid, gateway: true, refs: new Set<string>() }) as unknown as SocketMeta
                            )
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
                        this.#connections.get(client_id)?.send(JSON.stringify(event))
                    })
                )
            ).pipe(
                finalize(() => {
                    const id = (ws as any).id as string | undefined
                    if (id) this.#connections.delete(id)
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
        if (this.#closed) return
        this.#closed = true
        this.#updatesSubscription.unsubscribe()

        for (const pipe of this.#pipes.values()) {
            pipe.s.unsubscribe()
        }

        const server = this.#server
        this.#server = undefined
        const httpServer = this.#httpServer as http.Server & {
            [HTTP_SERVER_GATEWAYS]?: Set<WebsocketGateway>
        } | undefined
        this.#httpServer = undefined
        httpServer?.[HTTP_SERVER_GATEWAYS]?.delete(this)
        if (server instanceof WebSocketServer) {
            for (const client of server.clients) {
                client.terminate()
            }
            server.close()
        } else {
            for (const socket of this.#sockets) {
                socket.close()
            }
            server?.stop(true)
        }

        this.#sockets.clear()
        this.#connections.clear()
        this.#subscriptions.clear()
        this.#pipes.clear()

        this.complete()
    }
}
