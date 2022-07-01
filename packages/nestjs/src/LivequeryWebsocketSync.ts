
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway } from "@nestjs/websockets";
import { Subject } from "rxjs";
import JWT from 'jsonwebtoken'
import { LivequeryInterceptor, RealtimeSubscription } from "./LivequeryInterceptor";
import { v4 } from 'uuid'
import { Optional } from "@nestjs/common";
import { InjectWebsocketPublicKey } from "./UseWebsocketShareKeyPair";
import { UpdatedDataType } from "@livequery/types";

export declare type UpdatedData<T = any> = {
    data: Partial<T> & {
        id: string;
    };
    type: UpdatedDataType;
    collection_ref: string;
}

type ConnectionID = string
type Ref = string

@WebSocketGateway({ path: process.env.REALTIME_UPDATE_SOCKET_PATH || '/livequery/realtime-updates' })
export class LivequeryWebsocketSync {

    #connections = new Map<ConnectionID, { socket: WebSocket & { id: string }, refs: Set<Ref> }>()
    #refs = new Map<Ref, Map<ConnectionID, { socket: WebSocket & { id: string } }>>()

    public readonly changes = new Subject<UpdatedData>()

    constructor(
        @Optional() @InjectWebsocketPublicKey() private secret_or_public_key: string,
        @Optional() LivequeryInterceptor: LivequeryInterceptor,
    ) {
        if (!LivequeryInterceptor && !secret_or_public_key) throw new Error('Missing secret key for websocket, use UseWebsocketPublicKey in provider')

        this.changes.subscribe(({ collection_ref, data, type }) => {
            const connections = new Set([
                ...this.#refs.get(collection_ref)?.values() || [],
                ...this.#refs.get(`${collection_ref}/${data.id}`)?.values() || []
            ])
            if (connections.size > 0) {
                const payload = JSON.stringify({ event: 'sync', data: { changes: [{ ref: collection_ref, data, type }] } })
                connections.forEach(({ socket }) => socket.OPEN && socket.send(payload))
            }

        })
    }

    private async handleDisconnect(socket: WebSocket & { id: string }) {
        this.#connections.get(socket.id)?.refs.forEach(ref => {
            this.#refs.get(ref)?.delete(socket.id)
        })
        this.#connections.delete(socket.id)
    }

    @SubscribeMessage('start')
    start(
        @MessageBody() { id = v4() }: { id: string },
        @ConnectedSocket() socket: WebSocket & { id: string }
    ) {
        if (typeof id == 'string' && id.length < 40) {
            socket.id = id
            this.#connections.set(id, { socket, refs: new Set() })
        }

    }

    @SubscribeMessage('subscribe')
    async subscribe(
        @MessageBody() { realtime_key }: { realtime_key: string },
        @ConnectedSocket() socket: WebSocket & { id: string }
    ) {
        if (realtime_key && this.secret_or_public_key) {
            const options = await new Promise<RealtimeSubscription>(s => JWT.verify(
                realtime_key,
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
        this.#connections.get(socket.id)?.refs.delete(ref)
        this.#refs.get(ref)?.delete(socket.id)
    }

    listen(connection_id: string, subscription: RealtimeSubscription) {

        const connection = this.#connections.get(connection_id)


        if (connection) {
            const { collection_ref, doc_id } = subscription
            const ref = `${collection_ref}${doc_id ? `/${doc_id}` : ''}`
            const { socket, refs } = connection
            refs.add(ref)

            !this.#refs.has(ref) && this.#refs.set(ref, new Map())
            !this.#refs.get(ref).has(connection_id) && this.#refs.get(ref).set(connection_id, { socket })

        }
    }
}
