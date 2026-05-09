import { Subject, Observable, Subscription, BehaviorSubject, of, merge, EMPTY, timer } from 'rxjs'
import { map, filter, mergeAll, finalize, tap, switchMap, retry, takeWhile } from 'rxjs/operators'
import { UpdatedData, LivequeryBaseEntity } from '@livequery/types'
import { randomUUID } from 'crypto'
import { hidePrivateFields } from './helpers/hidePrivateFields.js'
import { NODE_ID, WEBSOCKET_PATH } from './const.js'

export type WebSocketHelloEvent = {
    event: 'hello'
    gid: string
}

export type WebSocketUnsubscribeEvent = {
    event: 'unsubscribe'
    data: {
        ref?: string
        refs?: string[]
        client_id: string
    }
}

export type WebSocketStartEvent = {
    event: 'start'
    data: {
        id: string
        auth: string
    }
}

export type RealtimeSubscription = {
    ref: string
    client_id: string
    gateway_id: string
    listener_node_id: string
}

export type WebSocketSubscribeEvent = RealtimeSubscription & { event: 'subscribe' }

export type WebSocketSyncEvent = {
    event: 'sync'
    cids: string[]
    data?: {
        changes: UpdatedData[]
    }
}

export interface WebSocketLike {
    send(data: string): void
    close(): void
}

export type WebsocketWithMetadata = WebSocketLike & {
    gateway: boolean
    id: string
    refs: Set<string>
}

export type SubscriptionMetadata = { gateway_id: string; listener_node_id: string }

type GatewayId = string
type Ref = string
type ClientId = string

const ENDPOINT_RESTARTED = 'ENDPOINT_RESTARTED'

export class LivequeryWebsocketSync extends Subject<UpdatedData> {

    #connections = new Map<GatewayId | ClientId, WebsocketWithMetadata>()
    #subscriptions = new Map<Ref, Map<ClientId, SubscriptionMetadata>>()
    #pipes = new Map<Ref, { o: Observable<any>; s: Subscription }>()

    public readonly id = NODE_ID
    public readonly auth = randomUUID()

    constructor() {
        super()
        this.subscribe(({ ref, data, type }) => {
            const targets = [
                ...this.#subscriptions.get(ref) || new Map<ClientId, SubscriptionMetadata>(),
                ...this.#subscriptions.get(`${ref}/${data.id}`) || new Map<ClientId, SubscriptionMetadata>()
            ].reduce((p, [client_id, { gateway_id }]) => {
                const connection_id = gateway_id == NODE_ID ? client_id : gateway_id
                const old = p.get(connection_id)
                const socket = old ? old.socket : this.#connections.get(connection_id)
                if (!socket) return p
                const cids = [...old ? old.cids : [], client_id]
                p.set(connection_id, { cids, socket })
                return p
            }, new Map<string, { socket: WebSocketLike; cids: string[] }>())

            for (const [_, { cids, socket }] of targets) {
                const event: WebSocketSyncEvent = {
                    event: 'sync',
                    cids,
                    data: { changes: [{ ref, data, type }] }
                }
                socket.send(JSON.stringify(event))
            }
        })
    }

    async link<T extends LivequeryBaseEntity>(
        ref: string,
        handler: (o?: Observable<UpdatedData<T>>) => Promise<Observable<UpdatedData<T>>> | Observable<UpdatedData<T>> | undefined | void
    ) {
        if (!this.#subscriptions.has(ref)) return
        const m = this.#pipes.get(ref)
        const merged = handler(m?.o)
        const o = merged instanceof Promise ? await merged : merged
        if (!o || o == m?.o) return
        m?.s.unsubscribe()
        this.#pipes.set(ref, {
            o,
            s: o.pipe(
                finalize(() => { this.#pipes.delete(ref) })
            ).subscribe(data => this.next(data))
        })
    }

    // Called by framework adapters when a socket connects
    handleOpen(socket: WebSocketLike): WebsocketWithMetadata {
        return Object.assign(socket, {
            gateway: false,
            id: '',
            refs: new Set<string>()
        }) as WebsocketWithMetadata
    }

    // Called by framework adapters when a message arrives
    handleMessage(socket: WebsocketWithMetadata, message: string): void {
        try {
            const parsed = JSON.parse(message) as
                | WebSocketStartEvent
                | WebSocketSubscribeEvent
                | WebSocketUnsubscribeEvent

            if (parsed.event === 'start') {
                this.#handleStart(socket, (parsed as WebSocketStartEvent).data)
            } else if (parsed.event === 'subscribe') {
                this.listen([parsed as WebSocketSubscribeEvent])
            } else if (parsed.event === 'unsubscribe') {
                this.#handleUnsubscribe(socket, (parsed as WebSocketUnsubscribeEvent).data)
            }
        } catch { }
    }

    // Called by framework adapters when a socket disconnects
    handleClose(socket: WebsocketWithMetadata): void {
        this.#handleDisconnect(socket)
    }

    // Returns handlers ready to plug into Bun.serve()
    createBunHandlers(path = WEBSOCKET_PATH) {
        const sync = this
        return {
            fetch(req: Request, server: { upgrade(req: Request): boolean }) {
                const url = new URL(req.url)
                if (url.pathname !== path) return
                server.upgrade(req)
            },
            websocket: {
                open(ws: WebsocketWithMetadata) {
                    Object.assign(ws, { gateway: false, id: '', refs: new Set() })
                },
                message(ws: WebsocketWithMetadata, message: string) {
                    sync.handleMessage(ws, message)
                },
                close(ws: WebsocketWithMetadata) {
                    sync.handleClose(ws)
                }
            }
        }
    }

    // Connect to another node's WebSocket (gateway → service, or client → gateway)
    connect(url: string, auth: string, ondisconnect?: Function): Subscription {
        const gateway$ = new BehaviorSubject({ id: '', stop: false })

        return of(0).pipe(
            takeWhile(() => !gateway$.getValue().stop),
            map(() => new WebSocket(url)),
            switchMap((ws: WebSocket) => {
                const open$ = new Observable<void>(sub => {
                    ws.addEventListener('open', () => {
                        const payload: WebSocketStartEvent = { event: 'start', data: { id: NODE_ID, auth } }
                        ws.send(JSON.stringify(payload))
                        sub.next()
                        sub.complete()
                    })
                })

                const close$ = new Observable<never>(_ => {
                    ws.addEventListener('close', () => { throw 'CLOSED' })
                })

                const error$ = new Observable<never>(_ => {
                    ws.addEventListener('error', e => { throw e })
                })

                const message$ = new Observable<MessageEvent>(sub => {
                    ws.addEventListener('message', e => sub.next(e as MessageEvent))
                }).pipe(
                    map(event => {
                        const parsed = JSON.parse(event.data.toString()) as
                            | WebSocketSyncEvent
                            | WebSocketHelloEvent
                            | WebSocketSubscribeEvent

                        if (parsed.event == 'hello') {
                            const wsm = ws as any
                            wsm.id = parsed.gid
                            const old_id = gateway$.getValue().id
                            if (old_id == '') {
                                gateway$.next({ id: wsm.id, stop: false })
                            }
                            if (old_id != '' && old_id != wsm.id) {
                                gateway$.next({ id: wsm.id, stop: true })
                                throw ENDPOINT_RESTARTED
                            }
                            this.#connections.set(parsed.gid, wsm)
                            return null
                        }

                        if (parsed.event == 'subscribe') {
                            this.listen([parsed])
                            return null
                        }

                        return parsed as WebSocketSyncEvent
                    }),
                    filter(Boolean),
                    map(({ cids, data }: WebSocketSyncEvent) =>
                        cids.map(client_id => ({ data, client_id }))
                    ),
                    mergeAll(),
                    tap(({ client_id, data }) => {
                        const socket = this.#connections.get(client_id)
                        socket && socket.send(JSON.stringify({ event: 'sync', data }))
                    })
                )

                return merge(open$, close$, error$, message$).pipe(
                    finalize(() => {
                        this.#connections.delete((ws as any).id)
                    })
                )
            }),
            retry({
                delay: (e, n) => {
                    if (n >= 5 || e == ENDPOINT_RESTARTED) return EMPTY
                    return timer(1000)
                }
            }),
            finalize(() => {
                ondisconnect?.()
            })
        ).subscribe()
    }

    listen(e: Array<RealtimeSubscription>): void {
        for (const { ref, client_id, gateway_id, listener_node_id } of e) {
            if (client_id == gateway_id) continue
            const socket = this.#connections.get(client_id)
            if (gateway_id == NODE_ID && (!socket || socket.refs?.has(ref))) {
                if (listener_node_id != NODE_ID) {
                    const target = this.#connections.get(listener_node_id)
                    if (target) {
                        const payload: WebSocketUnsubscribeEvent = {
                            event: 'unsubscribe',
                            data: { client_id, ref }
                        }
                        target.send(JSON.stringify(payload))
                    }
                }
                continue
            }
            const map = this.#subscriptions.get(ref) || new Map<ClientId, SubscriptionMetadata>()
            if (map.has(client_id)) continue
            map.set(client_id, { gateway_id, listener_node_id })
            this.#subscriptions.set(ref, map)
            this.#connections.get(client_id)?.refs?.add(ref)

            if (gateway_id != NODE_ID) {
                const target = this.#connections.get(gateway_id)
                if (target) {
                    const payload: WebSocketSubscribeEvent = {
                        client_id,
                        event: 'subscribe',
                        gateway_id,
                        ref,
                        listener_node_id
                    }
                    target.send(JSON.stringify(payload))
                }
            }
        }
    }

    #handleStart(socket: WebsocketWithMetadata, { id, auth }: WebSocketStartEvent['data']) {
        if (socket.id) return
        if (auth && auth != this.auth) {
            socket.close()
            return
        }
        if (this.#connections.has(id)) {
            socket.close()
            return
        }
        socket.id = id
        socket.gateway = auth == this.auth
        socket.refs = new Set()
        this.#connections.set(id, socket)
        const payload: WebSocketHelloEvent = { event: 'hello', gid: NODE_ID }
        socket.send(JSON.stringify(payload))
    }

    #handleUnsubscribe(socket: WebsocketWithMetadata, body: { ref?: string; client_id?: string; refs?: string[] }) {
        const client_id = body.client_id || socket.id
        const refs = [
            ...body.ref ? [body.ref] : [],
            ...body.refs || []
        ]
        for (const ref of refs) {
            const map = this.#subscriptions.get(ref)
            if (!map) return
            const routing = map.get(client_id)
            map.delete(client_id)

            if (map.size == 0) {
                const $ = this.#pipes.get(ref)
                $?.s?.unsubscribe()
                this.#subscriptions.delete(ref)
            }

            this.#connections.get(client_id)?.refs?.delete(ref)

            if (routing?.listener_node_id != NODE_ID) {
                const gateway = this.#connections.get(routing.listener_node_id)
                if (gateway) {
                    const payload: WebSocketUnsubscribeEvent = { event: 'unsubscribe', data: { ref, client_id } }
                    gateway.send(JSON.stringify(payload))
                }
            }
        }
    }

    #handleDisconnect(socket: WebsocketWithMetadata) {
        if (socket.gateway) {
            for (const [ref, map] of this.#subscriptions) {
                for (const [client_id, { gateway_id }] of map) {
                    if (gateway_id == socket.id) {
                        map.delete(client_id)
                    }
                }
                if (map.size == 0) {
                    const $ = this.#pipes.get(ref)
                    $?.s?.unsubscribe()
                    this.#subscriptions.delete(ref)
                }
            }
        } else {
            const refs = [...socket.refs || []]
            refs.length > 0 && this.#handleUnsubscribe(socket, { refs })
        }
        this.#connections.delete(socket.id)
    }
}
