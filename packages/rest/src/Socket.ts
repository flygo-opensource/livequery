import { fromEvent, Observable, Subject, BehaviorSubject, merge, ReplaySubject, Subscription, of, interval, EMPTY, timer } from "rxjs";
import { catchError, finalize, map, mergeMap, retry, switchMap, takeUntil, tap } from "rxjs/operators";
import type { DataChangeEvent } from '@livequery/client'
import { v7 as uuidv7 } from 'uuid';
import { decode, encode } from '@msgpack/msgpack';

/**
 * Keep-alive frame, byte for byte. This is a copy of `LIVEQUERY_PING_FRAME` in `@livequery/core`,
 * kept as a literal so a browser bundle does not pull in the server package — `tests/keepalive-frame`
 * fails if the two ever drift apart.
 *
 * It is sent as this exact string, never through `#send`: a Cloudflare Durable Object answers the
 * ping in the runtime through `setWebSocketAutoResponse`, which matches the frame as an exact
 * string. Re-encoding it — msgpack in binary mode, a different key order, any added field — still
 * "works", but then every idle ping wakes the object instead of being answered for free.
 */
export const LIVEQUERY_PING_FRAME = '{"event":"ping"}'

export type LivequerySocketMetadata = {
    client_id: string
    gateway_id?: string
    connected: boolean
    session: number
}

type Frame = { data: object, event: string }

export class Socket extends BehaviorSubject<LivequerySocketMetadata> {

    public readonly client_id: string
    public readonly $gateway = new ReplaySubject<string>(1)

    #topics = new Map<string, { stream: Subject<DataChangeEvent>, listen_count: number }>()
    // Frames for the open connection; the ones made while it is down wait in #queue and go out
    // once, on the next open — never replayed on later connections.
    #$input = new Subject<Frame>()
    #queue: Frame[] = []
    #open = false

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
                // Emits once connected, which resets the retry backoff below.
                fromEvent(ws, 'open'),
                fromEvent(ws, 'close').pipe(map(e => { throw e })),
                fromEvent(ws, 'error').pipe(map(e => { throw e })),
                fromEvent(ws, 'open').pipe(
                    switchMap(() => interval(60000)),
                    tap(() => ws.send(LIVEQUERY_PING_FRAME))
                ),
                fromEvent(ws, 'open').pipe(
                    tap(() => {
                        this.next({
                            ... this.value,
                            connected: true,
                            session: this.value.session + 1
                        })
                        this.#send(ws, { event: 'start', data: { id: this.client_id } })
                        for (const frame of this.#queue.splice(0)) !this.#isStale(frame) && this.#send(ws, frame)
                        this.#open = true
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
                finalize(() => {
                    this.#open = false
                    ws.close()
                })
            )),
            catchError(e => {
                this.next({
                    ...this.value,
                    connected: false
                })
                throw e
            }),
            // Back off while the server stays unreachable; a connection that opened starts over at
            // 2s, so a drop after hours of uptime is not retried 30s later.
            retry({ delay: (_, attempt) => timer(Math.min(1000 * 2 ** attempt, 30000)), resetOnSuccess: true }),
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
            // The gateway emits realtime changes under the COLLECTION ref (e.g. `spaces`)
            // plus the document id, and fans out to document subscribers by matching
            // `${ref}/${id}` on its side. Document subscriptions here listen on the full ref
            // (e.g. `spaces/<id>`), so we must also route the change to that topic — otherwise
            // single-document `useDocument` never receives realtime updates.
            const id = change.id ?? change.data?.id
            if (id) this.#topics.get(`${change.ref}/${id}`)?.stream.next(change)
        }
    }

    private $hello(e: { gid: string, binary?: boolean }) {
        this.#binary = e.binary === true
        this.$gateway.next(e.gid)
    }


    subscribeWith(realtime_token: string) {
        this.#emit({ event: 'subscribe', data: { realtime_token } })
    }

    #emit(frame: Frame) {
        if (this.#open) this.#$input.next(frame)
        else this.#queue.push(frame)
    }

    // An unsubscribe for a ref that is listened to again: sending it would cut that ref off.
    #isStale(frame: Frame) {
        const ref = (frame.data as { ref?: string } | undefined)?.ref
        return frame.event === 'unsubscribe' && !!ref && (this.#topics.get(ref)?.listen_count ?? 0) > 0
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
                        this.#emit({ event: 'unsubscribe', data: { ref } })
                        this.#topics.delete(ref)
                    }
                }, 2000)
            })
        )
    }
}
