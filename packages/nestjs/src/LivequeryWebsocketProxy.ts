
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway } from "@nestjs/websockets";
import WebSocket from 'ws'


type SessionID = string
type Ref = string



@WebSocketGateway({ path: process.env.REALTIME_UPDATE_SOCKET_PATH || '/livequery/realtime-updates' })
export class LivequeryWebsocketProxy {

    #sessions = new Map<SessionID, { refs: Set<Ref>, socket: WebSocket }>()
    #sockets = new Map<WebSocket, Set<SessionID>>()

    #targets = new Set<WebSocket>()


    constructor() {
        setTimeout(() => this.connect('ws://128.199.217.97:80/livequery/realtime-updates'), 3000)
    }

    async connect(host: string) {
        const ws = new WebSocket(host)

        ws.on('message', data => {
            console.log(data.toString())
            try {
                const parsed = JSON.parse(data.toString()) as { event: string, session_id: string, data: any }
                parsed.session_id && this.#sessions.get(parsed.session_id).socket.send(data.toString())
            } catch (e) {
                console.error(e)
            }
        })

        ws.on('open', () => {
            console.log('Connected')
            this.#targets.add(ws)
        })

        ws.on('close', () => {
            this.#targets.delete(ws)
        })

        ws.on('error', () => {
            this.#targets.delete(ws)
        })
    }



    @SubscribeMessage('start')
    start(
        @ConnectedSocket() socket: WebSocket,
        @MessageBody() { id: session_id }: { id: string }
    ) {
        if (!session_id || session_id.length > 36) return

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
        @ConnectedSocket() socket: WebSocket,
        @MessageBody() { id: session_id }: { id: string }
    ) {
        this.#sockets.get(socket)?.delete(session_id)
        const session = this.#sessions.get(session_id)
        if (!session) return
        this.#sessions.delete(session_id);

        [...this.#targets].forEach(s => s.send(JSON.stringify({
            event: 'stop',
            id: session_id
        })))
    }

    @SubscribeMessage('subscribe')
    subscribe(
        @MessageBody() { realtime_token }: { realtime_token: string }
    ) {

        [...this.#targets].forEach(s => s.send(JSON.stringify({
            event: 'subscribe',
            realtime_token
        })))

    }

    @SubscribeMessage('unsubscribe')
    unsubscribe(
        @ConnectedSocket() socket: WebSocket,
        @MessageBody() { ref, id }: { ref: string, id?: string }
    ) {
        const session_ids = id ? [id] : (this.#sockets.get(socket) || [])
        for (const session_id of session_ids) {


            [...this.#targets].forEach(s => s.send(JSON.stringify({
                event: 'unsubscribe',
                ref,
                id: session_id
            })))

        }

    }
}
