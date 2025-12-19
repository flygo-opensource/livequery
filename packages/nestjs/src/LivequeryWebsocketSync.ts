
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway } from "@nestjs/websockets";
import { Subject, tap, switchMap, retry, timer, BehaviorSubject, takeWhile, Observable, Subscription, mergeMap } from "rxjs";
import { RealtimeSubscription } from "./LivequeryInterceptor.js";
import { UpdatedData, WebsocketSyncPayload, LivequeryBaseEntity } from "@livequery/types";

import WebSocket from 'ws'
import { of, fromEvent, map, finalize, merge, EMPTY, filter, mergeAll } from 'rxjs'
import { hidePrivateFields } from "./helpers/hidePrivateFields.js";
import { randomUUID } from "crypto";
import { RxjsUdp } from "./RxjsUdp.js";
import { LivequeryDatasource } from "./helpers/createDatasourceMapper.js";


export type WebSocketHelloEvent = {
    event: 'hello',
    gid: string
}

export type WebSocketUnsubscribeEvent = {
    event: 'unsubscribe',
    data: {
        ref?: string
        refs?: string
        client_id: string
    }

}

export type WebSocketStartEvent = {
    event: 'start',
    data: {
        id: string
        auth: string
    }
}

export type WebSocketSubscribeEvent = RealtimeSubscription & { event: 'subscribe' }

export type WebSocketSyncEvent = {
    event: 'sync'
    cids: string[]
    data?: {
        changes: UpdatedData[]
    }
}

export type WebsocketWithMetadata = WebSocket & {
    gateway: boolean
    id: string
    refs: Set<string>
}

export type SubscriptionMetadata = { gateway_id: string, listener_node_id: string }
export type SubscriberMetadata = Map<Ref, Subject<'STOP'>>

type GatewayId = string
type Ref = string
type ClientId = string

const ENDPOINT_RESTARTED = 'ENDPOINT_RESTARTED'

export const WEBSOCKET_PATH = process.env.REALTIME_UPDATE_SOCKET_PATH || '/livequery/realtime-updates'

@WebSocketGateway({ path: WEBSOCKET_PATH })
export class LivequeryWebsocketSync {

    #connections = new Map<GatewayId | ClientId, WebsocketWithMetadata>()
    #subscriptions = new Map<Ref, Map<ClientId, SubscriptionMetadata>>()
    #pipes = new Map<Ref, { o: Observable<any>, s: Subscription }>()


    // NODE METADATA
    public readonly id = RxjsUdp.id
    public readonly auth = randomUUID()
    private readonly changes = new Subject<UpdatedData>()

    constructor() {
        this.changes.subscribe(({ ref, data, type }) => {

            const targets = [
                ... this.#subscriptions.get(ref) || new Map<ClientId, SubscriptionMetadata>(),
                ...this.#subscriptions.get(`${ref}/${data.id}`) || new Map<ClientId, SubscriptionMetadata>()
            ].reduce((p, [client_id, { gateway_id }]) => {
                const connection_id = gateway_id == this.id ? client_id : gateway_id
                const old = p.get(connection_id)
                const socket = old ? old.socket : this.#connections.get(connection_id)
                if (!socket) return p
                const cids = [...old ? old.cids : [], client_id]
                p.set(connection_id, { cids, socket })
                return p
            }, new Map<string, { socket: WebSocket, cids: string[] }>())

            for (const [_, { cids, socket }] of targets) {
                const event: WebSocketSyncEvent = {
                    event: 'sync',
                    cids,
                    data: { changes: [{ ref, data, type }] }
                }
                const payload = JSON.stringify(event)
                socket.send(payload)
            }


        })
    }


    async pipe<T extends LivequeryBaseEntity>(ref: string, handler: (o?: Observable<UpdatedData<T>>) => Promise<Observable<UpdatedData<T>>> | Observable<UpdatedData<T>> | undefined | void) {
        if (!this.#subscriptions.has(ref)) return;
        const m = this.#pipes.get(ref);
        const merged = handler(m?.o);
        const o = merged instanceof Promise ? await merged : merged
        if (!o || o == m?.o) return
        m?.s.unsubscribe();
        this.#pipes.set(ref, {
            o,
            s: o.pipe(
                finalize(() => {
                    this.#pipes.delete(ref)
                })
            ).subscribe(data => this.changes.next(data))
        });
    }

    connect(url: string, auth: string, ondisconect?: Function) {
        const gateway$ = new BehaviorSubject({ id: '', stop: false })
        return of(0).pipe(
            takeWhile(() => !gateway$.getValue().stop),
            map(() => new WebSocket(url)),
            switchMap((ws: WebsocketWithMetadata) => {
                return merge(
                    fromEvent(ws, 'open').pipe(tap(() => {
                        const payload: WebSocketStartEvent = { event: 'start', data: { id: this.id, auth } }
                        ws.send(JSON.stringify(payload))
                    })),
                    fromEvent(ws, 'close').pipe(map(() => { throw 'CLOSED' })),
                    fromEvent(ws, 'error').pipe(map(e => { throw e })),
                    fromEvent(ws, 'message').pipe(
                        map((event: { data: string }) => {
                            const data = event.data
                            const parsed = JSON.parse(data.toString()) as WebSocketSyncEvent | WebSocketHelloEvent | WebSocketSubscribeEvent

                            if (parsed.event == 'hello') {
                                ws.id = parsed.gid
                                const old_id = gateway$.getValue().id
                                if (old_id == '') {
                                    gateway$.next({ id: ws.id, stop: false })
                                }
                                if (old_id != '' && old_id != ws.id) {
                                    gateway$.next({ id: ws.id, stop: true })
                                    throw ENDPOINT_RESTARTED
                                }
                                this.#connections.set(parsed.gid, ws)
                                return
                            }
                            if (parsed.event == 'subscribe') {
                                this.listen([parsed])
                                return
                            }

                            return parsed
                        }),
                        filter(Boolean),
                        map(({ event, cids, data }) => cids.map(client_id => ({ event, data, client_id }))),
                        mergeAll(),
                        tap(({ client_id, ...event }) => {
                            const socket = this.#connections.get(client_id)
                            socket && socket.send(JSON.stringify(event))
                        })
                    )
                ).pipe(
                    finalize(() => {
                        this.#connections.delete(ws.id)
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
                ondisconect?.()
            })
        ).subscribe()

    }

    broadcast<T extends LivequeryBaseEntity = LivequeryBaseEntity>(event: WebsocketSyncPayload<T>) {
        const id = event.old_data?.id || event.new_data?.id
        if (!id) return

        if (event.type == 'added') {
            this.changes.next({
                data: hidePrivateFields({ ...event.new_data, id }),
                ref: event.new_ref,
                type: event.type
            })
            return
        }

        if (event.type == 'modified') {
            if (event.old_ref == event.new_ref) {
                const changes = {
                    ...Object
                        .keys(event.new_data)
                        .filter(key => !key.startsWith('_') && event.new_data[key] != event.old_data[key])
                        .reduce(
                            (p, key) => ({ ...p || {}, [key]: event.new_data[key] }), {}
                        ),
                    id
                }
                this.changes.next({
                    type: 'modified',
                    ref: event.new_ref,
                    data: changes
                })
            } else {
                this.changes.next({
                    type: 'removed',
                    ref: event.old_ref,
                    data: { id }
                })

                this.changes.next({
                    type: 'added',
                    ref: event.new_ref,
                    data: hidePrivateFields({ ...event.old_data || {}, ...event.new_data || {}, id })
                })
            }
            return
        }

        if (event.type == 'removed') {
            this.changes.next({
                data: { id },
                ref: event.old_ref,
                type: event.type
            })
            return
        }
    }

    @SubscribeMessage('start')
    start(
        @ConnectedSocket() socket: WebsocketWithMetadata,
        @MessageBody() { id, auth }: WebSocketStartEvent['data']
    ) {
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
        const payload: WebSocketHelloEvent = { event: 'hello', gid: this.id }
        socket.send(JSON.stringify(payload))
    }


    @SubscribeMessage('unsubscribe')
    unsubscribe(
        @ConnectedSocket() socket: WebsocketWithMetadata,
        @MessageBody() body: { ref?: string, client_id?: string, refs?: string[] }
    ) {
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
            // this.#subscribers.get(client_id)?.get(ref)?.next('STOP')


            // Need remote unsubscribe
            if (routing.listener_node_id != this.id) {
                const gateway = this.#connections.get(routing.listener_node_id)
                if (gateway) {
                    const payload: WebSocketUnsubscribeEvent = { event: 'unsubscribe', data: { ref, client_id } }
                    gateway && gateway.send(JSON.stringify(payload))
                }
            }
        }

    }

    private handleDisconnect(socket: WebsocketWithMetadata) {

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
            refs.length > 0 && this.unsubscribe(socket, { refs })
        }
        this.#connections.delete(socket.id)

    }


    listen(e: Array<RealtimeSubscription>) {

        for (const { ref, client_id, gateway_id, listener_node_id } of e) {
            if (client_id == gateway_id) continue
            const socket = this.#connections.get(client_id)
            if (gateway_id == this.id && (!socket || socket.refs?.has(ref))) {
                if (listener_node_id != this.id) {
                    const target = this.#connections.get(listener_node_id)
                    if (target) {
                        const e: WebSocketUnsubscribeEvent = {
                            event: 'unsubscribe',
                            data: { client_id, ref }
                        }
                        target.send(JSON.stringify(e))
                    }
                }
                continue
            }
            const map = this.#subscriptions.get(ref) || new Map<ClientId, SubscriptionMetadata>()
            if (map.has(client_id)) continue
            map.set(client_id, { gateway_id, listener_node_id })
            this.#subscriptions.set(ref, map)
            this.#connections.get(client_id)?.refs?.add(ref)

            if (gateway_id != this.id) {
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


    #linkded = new Map<LivequeryDatasource<any>, Subscription>()
    link(ds: LivequeryDatasource<any>) {
        if (this.#linkded.has(ds)) return
        this.#linkded.set(ds,
            ds.pipe(
                tap(event => this.broadcast(event))
            ).subscribe()
        )
    }



}