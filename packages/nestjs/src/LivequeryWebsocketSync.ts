
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway } from "@nestjs/websockets";
import { Subject } from "rxjs";
import { RealtimeSubscription } from "./LivequeryInterceptor.js";
import { randomUUID } from 'crypto'
import { Optional } from "@nestjs/common";
import { InjectWebsocketPublicKey } from "./UseWebsocketShareKeyPair.js";
import { UpdatedData, WebsocketSyncPayload, LivequeryBaseEntity } from "@livequery/types";
import JWT from 'jsonwebtoken'



type ConnectionID = string
type Ref = string


@WebSocketGateway({ path: process.env.REALTIME_UPDATE_SOCKET_PATH || '/livequery/realtime-updates' })
export class LivequeryWebsocketSync {

    private connections = new Map<ConnectionID, { socket: WebSocket & { id: string }, refs: Set<Ref> }>()
    private refs = new Map<Ref, Map<ConnectionID, { socket: WebSocket & { id: string } }>>()

    private readonly changes = new Subject<UpdatedData>()

    constructor(
        @Optional() @InjectWebsocketPublicKey() private secret_or_public_key: string,
    ) {
        this.changes.subscribe(({ ref, data, type, ...rest }) => {
            const connections = new Set([
                ...this.refs.get(ref)?.values() || [],
                ...this.refs.get(`${ref}/${data.id}`)?.values() || []
            ])

            if (connections.size > 0) {
                const payload = JSON.stringify({ event: 'sync', data: { changes: [{ ref, data, type }] } })
                connections.forEach(({ socket }) => socket.OPEN && socket.send(payload))
            }

        })
    }

    private async handleDisconnect(socket: WebSocket & { id: string }) {
        this.connections.get(socket.id)?.refs.forEach(ref => {
            this.refs.get(ref)?.delete(socket.id)
        })
        this.connections.delete(socket.id)
    }

    broadcast<T extends LivequeryBaseEntity = LivequeryBaseEntity>(event: WebsocketSyncPayload<T>){
        const id = event.old_data?.id || event.new_data?.id
        if (!id) return

        if (event.type == 'added') {
            this.changes.next({
                data: { ...event.new_data, id },
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
                        .filter(key => event.new_data[key] != event.old_data[key])
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
                    data: { ...event.old_data || {}, ...event.new_data || {}, id }
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
        @MessageBody() { id = randomUUID() }: { id: string },
        @ConnectedSocket() socket: WebSocket & { id: string }
    ) {
        if (typeof id == 'string' && id.length < 40) {
            socket.id = id
            this.connections.set(id, { socket, refs: new Set() })
        }

    }

    @SubscribeMessage('subscribe')
    async subscribe(
        @MessageBody() { realtime_token }: { realtime_token: string },
        @ConnectedSocket() socket: WebSocket & { id: string }
    ) {
        if (realtime_token && this.secret_or_public_key) {
            const options = await new Promise<RealtimeSubscription>(s => JWT.verify(
                realtime_token,
                this.secret_or_public_key,
                {},
                (error, data: RealtimeSubscription) => s(error ? null : data)
            ))
            options && this.listen(socket.id, options)
        }

    }

    @SubscribeMessage('unsubscribe')
    unsubscribe(
        @MessageBody() { ref }: { ref: string },
        @ConnectedSocket() socket: WebSocket & { id: string }
    ) {
        this.connections.get(socket.id)?.refs.delete(ref)
        this.refs.get(ref)?.delete(socket.id)
    }

    listen(connection_id: string, subscription: RealtimeSubscription) {

        const connection = this.connections.get(connection_id)

        if (connection) {
            const { collection_ref, doc_id } = subscription
            const ref = `${collection_ref}${doc_id ? `/${doc_id}` : ''}`
            const { socket, refs } = connection
            refs.add(ref)
            !this.refs.has(ref) && this.refs.set(ref, new Map())
            !this.refs.get(ref).has(connection_id) && this.refs.get(ref).set(connection_id, { socket })

        }
    }
}
