import { UpdatedData } from "@livequery/types";
import { firstValueFrom, fromEvent, Observable, Subject, BehaviorSubject, merge, ReplaySubject, Subscription, of, interval } from "rxjs";
import { delay, filter, finalize, map, mergeMap, retry, switchMap, tap } from "rxjs/operators";
import { v4 } from 'uuid'

export class Socket {

    public readonly client_id = v4()
    public readonly $gateway = new BehaviorSubject<{ id: string } | undefined>(undefined)
    public readonly $reconnect = new BehaviorSubject(0)

    #topics = new Map<string, { stream: Subject<UpdatedData>, listen_count: number }>()
    #$input = new ReplaySubject<{ data: object, event: string }>(1000)

    #running: Subscription | undefined


    #init() {
        if (typeof WebSocket == 'undefined') return

        return of(1).pipe(
            mergeMap(async () => new WebSocket(await this.ws_url_fatory())),
            switchMap(ws => merge(
                fromEvent(ws, 'closed').pipe(map(e => { throw e })),
                fromEvent(ws, 'close').pipe(map(e => { throw e })),
                fromEvent(ws, 'error').pipe(map(e => { throw e })),
                fromEvent(ws, 'open').pipe(
                    switchMap(() => interval(60000)),
                    tap(() => ws.send(JSON.stringify({ event: 'ping' })))
                ),
                fromEvent(ws, 'open').pipe(
                    tap(() => {
                        console.log(this.$reconnect.getValue() == 0 ? 'Websocket connected' : `Websocket re-connected (${this.$reconnect.getValue()})`)
                        this.$reconnect.next(this.$reconnect.getValue() + 1)
                        ws.send(JSON.stringify({ event: 'start', data: { id: this.client_id } }))
                    }),
                    delay(1),
                    tap(() => !this.$gateway.getValue() && this.$gateway.next({ id: '' })),
                    mergeMap(() => this.#$input),
                    tap(data => ws.send(JSON.stringify(data)))
                ),
                fromEvent(ws, 'message').pipe(
                    tap((evt: any) => {
                        const e = JSON.parse(evt.data) as { event: string }
                        this[`$${e.event}`]?.(e)
                    })
                )
            ).pipe(
                finalize(() => ws.close())
            )),
            retry({ delay: 1000 })
        ).subscribe()
    }

    constructor(private ws_url_fatory: () => string | Promise<string>) {
        this.#running = this.#init()
    }

    stop() {
        this.#running?.unsubscribe()
    }

    private $sync(e: { data: { changes: UpdatedData<any>[] } }) {
        for (const change of e.data.changes) {

            // Collection ref broadcast
            this.#topics.get(change.ref)?.stream.next(change)

            // Document ref broadcast
            const ref = `${change.ref}/${change.data.id}`
            this.#topics.get(ref)?.stream.next({
                ...change,
                ref
            })
        }
    }

    $hello(e: { gid: string }) {
        this.$gateway.next({ id: e.gid })
    }


    subscribe(realtime_token: string) {
        this.#$input.next({ event: 'subscribe', data: { realtime_token } })
    }


    listen(ref: string): Observable<UpdatedData> {
        if (!this.#topics.has(ref)) {
            const stream = new Subject<UpdatedData>()
            this.#topics.set(ref, { stream, listen_count: 0 })
        }

        this.#topics.get(ref).listen_count++

        return this.#topics.get(ref).stream.pipe(
            finalize(() => {
                this.#topics.get(ref).listen_count--
                setTimeout(() => {
                    if (this.#topics.get(ref).listen_count == 0) {
                        this.#$input.next({ event: 'unsubscribe', data: { ref } })
                    }
                }, 2000)
            })
        )
    }
}