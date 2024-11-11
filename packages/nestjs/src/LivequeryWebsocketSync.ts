
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway } from "@nestjs/websockets";
import { Subject, tap } from "rxjs";
import { RealtimeSubscription } from "./LivequeryInterceptor.js";
import { Optional } from "@nestjs/common";
import { InjectWebsocketPublicKey } from "./UseWebsocketShareKeyPair.js";
import { UpdatedData, WebsocketSyncPayload, LivequeryBaseEntity } from "@livequery/types";

import JWT from 'jsonwebtoken'
import { Socket } from "dgram";
import WebSocket from 'ws'
import { of, retry, fromEvent, map, finalize, mergeMap, merge, catchError, EMPTY } from 'rxjs'
import { hidePrivateFields } from "./helpers/hidePrivateFields.js";

type SessionID = string
type Ref = string

export type WebSocketSyncEvent = {
    event: string
    session_id: string
    data?: {
        changes: UpdatedData[]
    }
}

export const WEBSOCKET_PATH = process.env.REALTIME_UPDATE_SOCKET_PATH || '/livequery/realtime-updates'

@WebSocketGateway({ path: WEBSOCKET_PATH })
export class LivequeryWebsocketSync {

    #sessions = new Map<SessionID, { refs: Set<Ref>, socket: Socket }>()
    #refs = new Map<Ref, Map<SessionID, Socket>>()
    #sockets = new Map<Socket, Set<SessionID>>()

    private readonly changes = new Subject<UpdatedData>()

    #targets = new Set<WebSocket>()

    constructor(
        @Optional() @InjectWebsocketPublicKey() private secret_or_public_key: string,
    ) {
        this.changes.subscribe(({ ref, data, type }) => {

            const links = new Set([
                ...this.#refs.get(ref)?.entries() || [],
                ...this.#refs.get(`${ref}/${data.id}`)?.entries() || []
            ])

            for (const [session_id, socket] of links) {
                const event: WebSocketSyncEvent = {
                    event: 'sync',
                    session_id,
                    data: { changes: [{ ref, data, type }] }
                }
                const payload = JSON.stringify(event)
                socket.send(payload)
            }


        })
    }

    connect(url: string, ondisconect?: Function) {
        const ws = new WebSocket(url)
        return of(ws).pipe(
            mergeMap(ws => merge(
                fromEvent(ws, 'open').pipe(tap(() => this.#targets.add(ws))),
                fromEvent(ws, 'close').pipe(map(e => { throw e })),
                fromEvent(ws, 'error').pipe(map(e => { throw e })),
                fromEvent(ws, 'message').pipe(
                    map((event: { data: string }) => {
                        const data = event.data
                        try {
                            const parsed = JSON.parse(data.toString()) as { event: string, session_id: string, data: any }
                            parsed.session_id && this.#sessions.get(parsed.session_id)?.socket.send(data.toString())
                        } catch (e) {
                            console.error(e)
                        }
                    })
                )
            )),
            retry({ count: 3, delay: 500, resetOnSuccess: true }),
            catchError(() => EMPTY),
            finalize(() => {
                this.#targets.delete(ws)
                ondisconect?.()
            })
        ).subscribe()

    }

    private handleDisconnect(socket: Socket) {
        const sessions = this.#sockets.get(socket)
        if (!sessions) return
        this.#sockets.delete(socket)

        for (const session_id of sessions) {
            const session = this.#sessions.get(session_id)
            if (!session) continue
            this.#sessions.delete(session_id)

            for (const ref of session.refs) {
                this.#refs.get(ref)?.delete(session_id)
            }


        }

    }

    private handleConnection(socket: Socket) {
        this.#sockets.set(socket, new Set())
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
                        .filter(key => !key.startsWith('_') &&  event.new_data[key] != event.old_data[key])
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
        @ConnectedSocket() socket: Socket,
        @MessageBody() { id: session_id }: { id: string }
    ) {
        const id = Date.now()
        if (session_id && session_id.length > 36) return

        this.#sockets.get(socket)?.add(session_id)
        this.#sessions.set(session_id, {
            refs: new Set(),
            socket
        });

        [...this.#targets].forEach(s => s.send(JSON.stringify({
            event: 'start',
            data: { id: session_id }
        })))

    }


    @SubscribeMessage('stop')
    stop(
        @ConnectedSocket() socket: Socket,
        @MessageBody() { id: session_id }: { id: string }
    ) {
        [...this.#targets].forEach(s => s.send(JSON.stringify({
            event: 'stop',
            id: session_id
        })))

        this.#sockets.get(socket)?.delete(session_id)
        const session = this.#sessions.get(session_id)
        if (!session) return
        this.#sessions.delete(session_id)

        for (const ref of session.refs) {
            this.#refs.get(ref)?.delete(session_id)
        }
    }

    @SubscribeMessage('subscribe')
    async subscribe(
        @ConnectedSocket() socket: Socket & { id: string },
        @MessageBody() { realtime_token }: { realtime_token: string }
    ) {

        [...this.#targets].forEach(s => s.send(JSON.stringify({
            event: 'subscribe',
            realtime_token
        })))

        if (realtime_token && this.secret_or_public_key) {

            const options = await new Promise<RealtimeSubscription>(s => JWT.verify(
                realtime_token,
                this.secret_or_public_key,
                {},
                (error, data: RealtimeSubscription) => s(error ? null : data)
            ))
            if (options) {
                this.listen(options)
            }

        }

    }

    @SubscribeMessage('unsubscribe')
    unsubscribe(
        @ConnectedSocket() socket: Socket,
        @MessageBody() { ref, id }: { ref: string, id?: string }
    ) {
        const session_ids = id ? [id] : (this.#sockets.get(socket) || [])
        for (const session_id of session_ids) {

            [...this.#targets].forEach(s => s.send(JSON.stringify({
                event: 'unsubscribe',
                ref,
                id: session_id
            })))

            this.#refs.get(ref)?.delete(session_id)
            this.#sockets.get(socket)?.delete(session_id)

            const session = this.#sessions.get(session_id)
            if (!session) continue
            session.refs.delete(ref)

        }

    }


    listen({ collection_ref, doc_id, session_id }: RealtimeSubscription) {
        const session = this.#sessions.get(session_id)
        if (!session) return
        const ref = `${collection_ref}${doc_id ? `/${doc_id}` : ''}`
        const { socket, refs } = session
        refs.add(ref)
        !this.#refs.has(ref) && this.#refs.set(ref, new Map())
        !this.#refs.get(ref).has(session_id) && this.#refs.get(ref).set(session_id, socket)
    }
}
