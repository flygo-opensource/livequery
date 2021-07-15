import { UpdatedData } from "@livequery/types";
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway } from "@nestjs/websockets";
import { Subject } from "rxjs";
import { mergeMap } from "rxjs/operators";




@WebSocketGateway({ path: process.env.REALTIME_UPDATE_SOCKET_PATH || '/livequery/realtime-updates' })
export class LivequeryWebsocketSync {

    private connections = new Map<string, { socket: WebSocket, refs: Set<string> }>()
    private refs = new Map<string, Set<string>>()
    public readonly changes = new Subject<UpdatedData>()

    constructor() {
        this.changes.pipe(
            mergeMap(change => {
                const map = new Map<string, UpdatedData[]>()
                if (!map.has(change.ref)) map.set(change.ref, [])
                map.get(change.ref).push(change)
                return [...map.entries()].map(([ref, changes]) => ({ ref, changes }))
            })
        ).subscribe(({ ref, changes }) => {

            const connections = this.refs.get(ref)
            if (!connections) return
            const payload = JSON.stringify({ event: 'sync', data: { changes } })

            for (const cid of connections) {
                const connection = this.connections.get(cid)
                connection && connection.socket.OPEN && connection.socket.send(payload)
            }

        })
    }

    private async handleDisconnect(socket: WebSocket & { id: string }) {
        for (const ref of this.connections.get(socket.id)?.refs || []) {
            this.refs.get(ref).delete(socket.id)
        }
        this.connections.delete(socket.id)
    }

    @SubscribeMessage('start')
    subscribe(
        @MessageBody() { id }: { id: string },
        @ConnectedSocket() socket: WebSocket & { id: string }
    ) {
        this.connections.set(id, { refs: new Set(), socket })
        socket.id = id
    }

    @SubscribeMessage('unsubscribe')
    unsubscribe(
        @MessageBody() { ref }: { ref: string },
        @ConnectedSocket() socket: WebSocket & { id: string }
    ) {
        if (!this.connections.has(socket.id)) return
        const refs = [... this.connections.get(socket.id).refs]
        for (const ref of refs) this.refs.get(ref)?.delete(socket.id)
    }

    listen(connection_id: string, ref: string) {
        console.log(`Listen [${ref}] for ${connection_id}`)
        const cnn = this.connections.get(connection_id)
        if (cnn) {
            cnn.refs.add(ref)
            if (!this.refs.has(ref)) this.refs.set(ref, new Set())
            this.refs.get(ref).add(connection_id)
        }
    }
}