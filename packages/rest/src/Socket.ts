import { fromEvent, Observable, Subject, BehaviorSubject, merge, ReplaySubject, Subscription, of, interval, EMPTY } from "rxjs";
import { catchError, delay, finalize, ignoreElements, map, mergeMap, retry, switchMap, takeUntil, tap } from "rxjs/operators";
import type { DataChangeEvent } from '@livequery/core'
import { v7 as uuidv7 } from 'uuid';

export type LivequerySocketMetadata = {
    client_id: string
    gateway_id?: string
    connected: boolean
    session: number
}

export class Socket extends BehaviorSubject<LivequerySocketMetadata> {

    public readonly client_id = uuidv7()
    public readonly $gateway = new ReplaySubject<string>(1)
    public readonly $connected = new BehaviorSubject(false)

    #topics = new Map<string, { stream: Subject<DataChangeEvent>, listen_count: number }>()
    #$input = new ReplaySubject<{ data: object, event: string }>(1000)

    #running: Subscription | undefined

    constructor(private endpoint: string) {
        super({
            client_id: uuidv7(),
            connected: false,
            session: 0
        })
        this.#init()
    }

    #init() {
        if (typeof WebSocket == 'undefined') return
        if (this.#running) return
        this.#running = of(1).pipe(
            takeUntil(this.pipe(ignoreElements())),
            mergeMap(async () => new WebSocket(this.endpoint)),
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
                        this.next({
                            ... this.value,
                            connected: true,
                            session: this.value.session + 1
                        })
                        console.log(this.value.session == 1 ? 'Websocket connected' : `Websocket re-connected (${this.value.session})`)
                        ws.send(JSON.stringify({ event: 'start', data: { id: this.client_id } }))
                    }), 
                    mergeMap(() => this.#$input),
                    tap(data => ws.send(JSON.stringify(data)))
                ),
                fromEvent(ws, 'message').pipe(
                    tap((evt: any) => {
                        const e = JSON.parse(evt.data) as { event: string }
                        const fn = (this as any)[`$${e.event}`]
                        typeof fn == 'function' && fn.call(this, e)
                    })
                )
            ).pipe(
                finalize(() => ws.close())
            )),
            catchError(e => {
                this.$connected.next(false)
                throw e
            }),
            retry({ delay: 1000 })
        ).subscribe()
    }

    stop() {
        this.complete()
    }

    private $sync(e: { data: { changes: Array<DataChangeEvent & { ref: string }> } }) {
        for (const change of e.data.changes) {
            change.collection_ref = change.ref
            this.#topics.get(change.ref)?.stream.next(change)
        }
    }

    private $hello(e: { gid: string }) {
        this.$gateway.next(e.gid)
    }


    subscribeWith(realtime_token: string) {
        this.#$input.next({ event: 'subscribe', data: { realtime_token } })
    }


    listen(ref: string): Observable<DataChangeEvent> {
        if (!this.#topics.has(ref)) {
            const stream = new Subject<DataChangeEvent>()
            this.#topics.set(ref, { stream, listen_count: 0 })
        }
        const topic = this.#topics.get(ref)
        if (!topic) return EMPTY
        topic.listen_count++
        return topic.stream.pipe(
            finalize(() => {
                topic.listen_count--
                setTimeout(() => {
                    if (topic.listen_count == 0) {
                        this.#$input.next({ event: 'unsubscribe', data: { ref } })
                    }
                }, 2000)
            })
        )
    }
}