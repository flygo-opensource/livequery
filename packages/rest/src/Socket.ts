import { fromEvent, Observable, Subject, BehaviorSubject, merge, ReplaySubject, Subscription, of, interval, EMPTY, timer } from "rxjs";
import { catchError, finalize, map, mergeMap, retry, switchMap, takeUntil, tap } from "rxjs/operators";
import type { DataChangeEvent } from '@livequery/client'
import { v7 as uuidv7 } from 'uuid';
import { decode, encode } from '@msgpack/msgpack';

export type LivequerySocketMetadata = {
    client_id: string
    gateway_id?: string
    connected: boolean
    session: number
}

export class Socket extends BehaviorSubject<LivequerySocketMetadata> {

    public readonly client_id: string
    public readonly $gateway = new ReplaySubject<string>(1)

    #topics = new Map<string, { stream: Subject<DataChangeEvent>, listen_count: number }>()
    #$input = new ReplaySubject<{ data: object, event: string }>(1000)

    #running: Subscription | undefined
    #stop$ = new Subject<void>()
    #binary = false

    constructor(private endpoint: string) {
        const client_id = uuidv7()
        super({ client_id, connected: false, session: 0 })
        this.client_id = client_id
        this.#init()
    }

    #init() {
        if (typeof WebSocket == 'undefined') return
        if (this.#running) return
        this.#running = of(1).pipe(
            takeUntil(this.#stop$),
            mergeMap(async () => {
                const ws = new WebSocket(this.endpoint)
                ws.binaryType = 'arraybuffer'
                return ws
            }),
            switchMap(ws => merge(
                fromEvent(ws, 'close').pipe(map(e => { throw e })),
                fromEvent(ws, 'error').pipe(map(e => { throw e })),
                fromEvent(ws, 'open').pipe(
                    switchMap(() => interval(60000)),
                    tap(() => this.#send(ws, { event: 'ping' }))
                ),
                fromEvent(ws, 'open').pipe(
                    tap(() => {
                        this.next({
                            ... this.value,
                            connected: true,
                            session: this.value.session + 1
                        })
                        console.log(this.value.session == 1 ? 'Websocket connected' : `Websocket re-connected (${this.value.session})`)
                        this.#send(ws, { event: 'start', data: { id: this.client_id } })
                    }),
                    mergeMap(() => this.#$input),
                    tap(data => this.#send(ws, data))
                ),
                fromEvent(ws, 'message').pipe(
                    tap((evt: any) => {
                        const e = this.#parseMessage(evt.data) as { event: string }
                        const fn = (this as any)[`$${e.event}`]
                        typeof fn == 'function' && fn.call(this, e)
                    })
                )
            ).pipe(
                finalize(() => ws.close())
            )),
            catchError(e => {
                this.next({
                    ...this.value,
                    connected: false
                })
                throw e
            }),
            retry({ delay: (_, attempt) => timer(Math.min(1000 * 2 ** attempt, 30000)) }),
            takeUntil(this.#stop$)
        ).subscribe()
    }

    #parseMessage(data: string | ArrayBuffer) {
        if (typeof data === 'string') {
            try {
                return JSON.parse(data)
            } catch {
                try {
                    return decode(new TextEncoder().encode(data))
                } catch {
                    return undefined
                }
            }
        }
        try {
            return decode(new Uint8Array(data))
        } catch {
            return undefined
        }
    }

    #send(ws: WebSocket, data: { data?: object, event: string }) {
        ws.send(this.#binary ? encode(data) : JSON.stringify(data))
    }

    stop() {
        this.#stop$.next()
        this.#stop$.complete()
        this.complete()
    }

    private $sync(e: { data: { changes: Array<DataChangeEvent & { ref: string }> } }) {
        for (const change of e.data.changes) {
            change.collection_ref = change.ref
            this.#topics.get(change.ref)?.stream.next(change)
        }
    }

    private $hello(e: { gid: string, binary?: boolean }) {
        this.#binary = e.binary === true
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
                        this.#topics.delete(ref)
                    }
                }, 2000)
            })
        )
    }
}
