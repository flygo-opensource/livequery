import { UpdatedData } from "@livequery/types";
import { firstValueFrom, fromEvent, Observable, Subject, BehaviorSubject, merge } from "rxjs";
import { finalize } from "rxjs/operators";
import { v4 } from 'uuid'

export class Socket {

    private topics = new Map<string, { stream: Subject<UpdatedData>, listen_count: number }>()
    private $input = new Subject<{ data: object, event: string }>()
    public readonly $last_state = new BehaviorSubject<number>(0)
    public readonly socket_session = v4()


    private async init() {
        if (typeof WebSocket == 'undefined') return

        console.log('Use websocket to sync realtime data')

        for (let n = 0; true; n++) {
            console.log('Try connecting websocket .... ')
            const ws = new WebSocket(await this.ws_url_fatory())

            const messages_handler = fromEvent(ws, 'message').subscribe((evt: any) => {
                const { data, event } = JSON.parse(evt.data) as { event: string, data: any }
                this[`$${event}`]?.(data)
            })

            const connection_handler = fromEvent(ws, 'open').subscribe(() => {
                console.log('Websocket connected')
                ws.send(JSON.stringify({ event: 'start', data: { id: this.socket_session } }))
                const { unsubscribe } = this.$input.subscribe(data => ws.send(JSON.stringify(data)))
                this.$last_state.next(ws.readyState)
                return unsubscribe
            })

            await firstValueFrom(merge(fromEvent(ws, 'error'), fromEvent(ws, 'close'), fromEvent(ws, 'closed')))

            this.$last_state.next(ws.readyState)
            connection_handler.unsubscribe()
            messages_handler.unsubscribe()
            ws.close()

            console.log(`Websocket connection droped, reconnect in 1s`)
            await new Promise(s => setTimeout(s, 1000))

        }
    }

    constructor(private ws_url_fatory: () => string | Promise<string>) {
        this.init()
    }

    private $sync(data: { changes: UpdatedData<any>[] }) {
        for (const change of data.changes) {

            // Collection ref broadcast
            this.topics.get(change.ref)?.stream.next(change)

            // Document ref broadcast
            const ref = `${change.ref}/${change.data.id}`
            this.topics.get(ref)?.stream.next({
                ...change,
                ref
            })
        }
    }

    listen(ref: string): Observable<UpdatedData> {
        if (!this.topics.has(ref)) {
            const stream = new Subject<UpdatedData>()
            this.topics.set(ref, { stream, listen_count: 0 })
        }

        this.topics.get(ref).listen_count++

        const stream = this.topics.get(ref).stream.pipe(
            finalize(() => {
                this.topics.get(ref).listen_count--
                setTimeout(() => {
                    if (this.topics.get(ref).listen_count == 0) {
                        this.$input.next({ event: 'unsubscribe', data: { ref } })
                    }
                }, 2000)
            })
        )


        return stream
    }
}