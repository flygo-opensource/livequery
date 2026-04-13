import { EMPTY, finalize, fromEvent, mergeMap, takeUntil, tap } from "rxjs"
import { RpcChannel, type RpcMessage } from "./RpcChannel";



export class SharedWorkerChannel extends RpcChannel {

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
                return fromEvent<MessageEvent<RpcMessage>>(port, 'message').pipe(
                    takeUntil(fromEvent(port, 'messageerror')),
                    tap(msg => {
                        const respond = (response: any) => port.postMessage(response)
                        this.next({ ...msg.data, respond })
                    }),
                    finalize(() => {
                        console.log(`Worker disconnected, cleaning up linked services`)
                        port.close()
                    })
                )
            })
        ).subscribe()
    }

    #initForegound(worker: SharedWorker) {
        worker.port.start()
        const respond = (response: RpcMessage) => worker.port.postMessage(response)
        fromEvent<MessageEvent<RpcMessage>>(worker.port as unknown as EventTarget, 'message').pipe(
            tap(e => {
                this.next({ ...e.data, respond })
            }),
            takeUntil(fromEvent(worker.port as unknown as EventTarget, 'messageerror')),
            finalize(() => {
                console.log(`Worker disconnected, cleaning up linked services`)
                worker.port.close()
            })
        ).subscribe()
    }

    send(message: RpcMessage): void {
        if (!this.worker) return
        this.worker.port.postMessage(message)
    }
}