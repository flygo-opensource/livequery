import { catchError, EMPTY, finalize, fromEvent, merge, mergeMap, takeUntil, tap } from "rxjs"
import { RpcChannel, type RpcMessage } from "./RpcChannel.js";



export class SharedWorkerChannel extends RpcChannel {

    #connection_seq = 0

    constructor(private worker?: SharedWorker) {
        super();
        if (typeof window == 'undefined') {
            this.#initBackground()
        } else {
            if (worker) {
                this.#initForegound(worker)
            }
        }
    }


    #initBackground() {
        const me = globalThis as any as SharedWorkerGlobalScope
        fromEvent<MessageEvent>(me, 'connect').pipe(
            mergeMap(e => {
                const port = e.ports[0]
                if (!port) return EMPTY
                port.start()
                const connection_id = `c${this.#connection_seq++}`
                return fromEvent<MessageEvent<RpcMessage>>(port, 'message').pipe(
                    // `close` fires when the tab goes away (Chrome 122+): its streams are released
                    // instead of staying open in the worker for the worker's lifetime.
                    takeUntil(merge(fromEvent(port, 'messageerror'), fromEvent(port, 'close'))),
                    tap(msg => {
                        const respond = (response: RpcMessage['response']) => {
                            port.postMessage({
                                id: msg.data.id,
                                response
                            })
                        }

                        this.next({ ...msg.data, respond, connection_id })
                    }),
                    finalize(() => {
                        // Notify the manager so it can drop subscriptions for this connection.
                        this.next({ id: 0, disconnect: true, connection_id, respond: () => undefined })
                        port.close()
                    })
                )
            })
        ).subscribe()
    }

    #initForegound(worker: SharedWorker) {
        worker.port.start()
        fromEvent<MessageEvent<RpcMessage>>(worker.port as unknown as EventTarget, 'message').pipe(
            takeUntil(fromEvent(worker.port as unknown as EventTarget, 'messageerror')),
            tap(e => {
                const respond = (response: RpcMessage['response']) => {
                    const msg: RpcMessage = {
                        id: e.data.id,
                        response
                    }
                    worker.port.postMessage(msg)
                }
                this.next({ ...e.data, respond })
            }),
            finalize(() => worker.port.close()),
            catchError(() => {
                return EMPTY
            })
        ).subscribe()
    }

    send(message: RpcMessage): void {
        if (!this.worker) return
        this.worker.port.postMessage(message)
    }
}
