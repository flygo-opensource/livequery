
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway } from "@nestjs/websockets";
import { Subject, tap, switchMap, retry } from "rxjs";
import { RealtimeSubscription } from "./LivequeryInterceptor.js";
import { UpdatedData, WebsocketSyncPayload, LivequeryBaseEntity } from "@livequery/types";

import WebSocket from 'ws'
import { of, fromEvent, map, finalize, merge, catchError, EMPTY, filter, mergeAll } from 'rxjs'
import { hidePrivateFields } from "./helpers/hidePrivateFields.js";
import { randomUUID } from "crypto";


export type WebSocketHelloEvent = {
    event: 'hello',
    gid: string
}

export type WebSocketUnsubscribeEvent = {
    event: 'unsubscribe',
    data: {
        ref: string
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

type GatewayId = string
type Ref = string
type ClientId = string


export const WEBSOCKET_PATH = process.env.REALTIME_UPDATE_SOCKET_PATH || '/livequery/realtime-updates'

@WebSocketGateway({ path: WEBSOCKET_PATH })
export class LivequeryWebsocketSync {

    #connections = new Map<GatewayId | ClientId, WebsocketWithMetadata>()
    #subscriptions = new Map<Ref, Map<ClientId, GatewayId>>()


    // NODE METADATA
    public readonly id = randomUUID()
    public readonly auth = randomUUID()
    private readonly changes = new Subject<UpdatedData>()

    constructor() {
        this.changes.pipe()
        this.changes.subscribe(({ ref, data, type }) => {

            const targets = [
                ... this.#subscriptions.get(ref) || new Map(),
                ...this.#subscriptions.get(`${ref}/${data.id}`) || new Map()
            ].reduce((p, [client_id, gateway_id]) => {
                const connection_id = gateway_id == this.id ? client_id : gateway_id
                const old = p.get(connection_id)
                const socket = old ? old.socket : this.#connections.get(connection_id)
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

    connect(url: string, auth: string, ondisconect?: Function) {
        return of(0).pipe(
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
                            try {
                                const parsed = JSON.parse(data.toString()) as WebSocketSyncEvent | WebSocketHelloEvent | WebSocketSubscribeEvent

                                if (parsed.event == 'hello') {
                                    ws.id = parsed.gid
                                    this.#connections.set(parsed.gid, ws)
                                    return
                                }
                                if (parsed.event == 'subscribe') {
                                    this.listen([parsed])
                                    return
                                }

                                return parsed
                            } catch (e) {
                                console.error(e)
                            }
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
            // retry({ count: 10, delay: 1000, resetOnSuccess: false }),
            catchError(() => {
                return EMPTY
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
        process.env.LIVEQUERY_API_GATEWAY_DEBUG && console.log({
            new_node: id,
            gateway: auth == this.auth
        })
        if (socket.id) return
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
        @MessageBody() { ref, client_id = socket.id }: { ref: string, client_id?: string }
    ) {
        const subscriptions = this.#subscriptions.get(ref)
        if (!subscriptions) return
        const gateway_id = subscriptions.get(client_id)
        subscriptions.delete(client_id)

        // Is remote unsubscribe
        if (gateway_id == this.id) {
            const socket = this.#connections.get(client_id)
            socket.refs.delete(ref)
        } else {
            const gateway = this.#connections.get(gateway_id)
            const payload: WebSocketUnsubscribeEvent = { event: 'unsubscribe', data: { ref, client_id } }
            gateway && gateway.send(JSON.stringify(payload))
        }

    }

    private handleDisconnect(socket: WebsocketWithMetadata) {
        process.env.LIVEQUERY_API_GATEWAY_DEBUG && console.log({ disconnected: socket.id })
        this.#connections.delete(socket.id)
        if (socket.gateway) {
            for (const [ref, map] of this.#subscriptions) {
                for (const [client_id, gateway_id] of map) {
                    gateway_id == socket.id && map.delete(client_id)
                }
                map.size == 0 && this.#subscriptions.delete(ref)
            }
        } else {
            for (const ref of socket.refs) {
                const subscriptions = this.#subscriptions.get(ref)
                if (subscriptions) {
                    subscriptions.delete(ref)
                    subscriptions.size == 9 && this.#subscriptions.delete(ref)
                }
            }
        }
    }


    listen(e: RealtimeSubscription[]) {

        for (const { collection_ref, doc_id, client_id, gateway_id } of e) {
            if (client_id == gateway_id) continue
            const ref = `${collection_ref}${doc_id ? `/${doc_id}` : ''}`
            const subscriptions = this.#subscriptions.get(ref) || new Map<ClientId, GatewayId>()
            if (subscriptions.get(client_id) == gateway_id) continue 
            subscriptions.set(client_id, gateway_id)
            this.#subscriptions.set(ref, subscriptions)

            if (gateway_id == this.id) {
                const socket = this.#connections.get(client_id)
                socket && socket.refs.add(ref)
            } else {
                const gateway = this.#connections.get(gateway_id)
                const payload: WebSocketSubscribeEvent = { client_id, event: 'subscribe', gateway_id, collection_ref, doc_id }
                gateway && gateway.send(JSON.stringify(payload))
            }
        }
    }
}
