import { UpdatedData } from "@livequery/types";
import { firstValueFrom, fromEvent, Observable, Subject, BehaviorSubject, merge, ReplaySubject } from "rxjs";
import { finalize } from "rxjs/operators";
import { v4 } from 'uuid'

export class Socket {

    private topics = new Map<string, { stream: Subject<UpdatedData>, listen_count: number }>()
    private $input = new ReplaySubject<{ data: object, event: string }>(1000)
    public readonly $reconnect = new Subject<void>()
    public readonly socket_session = v4()


    async #init() {
        if (typeof WebSocket == 'undefined') return

        for (let n = 0; true; n++) {
            console.log('Connecting websocket .... ')
            const ws = new WebSocket(await this.ws_url_fatory())

            const messages_handler = fromEvent(ws, 'message').subscribe((evt: any) => {
                const { data, event } = JSON.parse(evt.data) as { event: string, data: any }
                this[`$${event}`]?.(data)
            })

            const data_sender = fromEvent(ws, 'open').subscribe(() => {
                console.log(n == 0 ? 'Websocket connected' : 'Websocket re-connected')
                ws.send(JSON.stringify({ event: 'start', data: { id: this.socket_session } }))
                const subscription = this.$input.subscribe(data => ws.send(JSON.stringify(data)))
                n > 0 && this.$reconnect.next()
                return () => {
                    subscription.unsubscribe()
                    this.$input.complete()
                }
            })

            await firstValueFrom(merge(fromEvent(ws, 'error'), fromEvent(ws, 'close'), fromEvent(ws, 'closed')))

            this.$input = new ReplaySubject(1000)
            data_sender.unsubscribe()
            messages_handler.unsubscribe()
            ws.close()

            console.log(`Websocket connection dropped, reconnect in 1s ...`)
            await new Promise(s => setTimeout(s, 1000))

        }
    }

    constructor(private ws_url_fatory: () => string | Promise<string>) {
        this.#init()
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

    subscribe(realtime_token: string) {
        this.$input.next({ event: 'subscribe', data: { realtime_token } })
    }

    listen(ref: string): Observable<UpdatedData> {
        if (!this.topics.has(ref)) {
            const stream = new Subject<UpdatedData>()
            this.topics.set(ref, { stream, listen_count: 0 })
        }

        this.topics.get(ref).listen_count++

        return this.topics.get(ref).stream.pipe(
            finalize(() => {
                this.topics.get(ref).listen_count--
                setTimeout(() => {
                    if (this.topics.get(ref).listen_count == 0) {
                        this.$input.next({ event: 'unsubscribe', data: { ref } })
                    }
                }, 2000)
            })
        )
    }
}