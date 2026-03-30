import { firstValueFrom, fromEvent, Observable, takeUntil, tap, type Subscriber } from "rxjs";


export type RpcRequest = {
    id: string;
    service: string
    method: string
    args: any[]
    sender_id: string
}

export type RpcResponse = {
    id: string;
    data?: any
    error?: string
    completed: boolean
}

export type RequestId = string

type ThenableObservable<T> = Observable<T> & PromiseLike<T>


function isObservableLike(value: unknown): value is { subscribe: (...args: any[]) => any } {
    return !!value && typeof value === 'object' && typeof (value as any).subscribe === 'function'
}

export class WorkerRpc {

    static #sender_id = crypto.randomUUID()
    static #workers = new Map<SharedWorker, Map<RequestId, {
        o: Subscriber<any>
    }>>()

    static #services = new Map<string, any>()

    // Allow service from worker to be called by main thread
    static exposeWorkerService(instance: any) {
        const serviceName = instance?.constructor?.name
        if (!serviceName) throw new Error('Service instance must have a constructor name')
        this.#services.set(serviceName, instance)

        fromEvent<MessageEvent<RpcRequest>>(globalThis as any, 'message').subscribe(async e => {
            const { id, service, method, args, sender_id } = e.data
            if (!id || !service || !method) return

            const svc = this.#services.get(service)
            if (!svc) return

            const post = (data: RpcResponse) => (globalThis as any).postMessage(data)
            const parts = String(method).split('/').filter(Boolean)
            let parent: any = null
            let target: any = svc
            for (const key of parts) {
                parent = target
                target = target?.[key]
            }

            if (typeof target === 'undefined') {
                post({ id, error: `Path "${method}" not found on service "${service}"`, completed: true })
                return
            }

            try {
                const callArgs = args || []
                const result = typeof target === 'function'
                    ? target.apply(parent, callArgs)
                    : (callArgs.length > 0
                        ? (() => { throw new Error(`Path "${method}" is not callable`) })()
                        : target)

                if (isObservableLike(result)) {
                    result.subscribe(
                        (data: any) => post({ id, data, completed: false }),
                        (err: any) => post({ id, error: err?.message ?? String(err), completed: true }),
                        () => post({ id, completed: true })
                    )
                } else {
                    const data = await Promise.resolve(result)
                    post({ id, data, completed: true })
                }
            } catch (err: any) {
                post({ id, error: err?.message ?? String(err), completed: true })
            } finally {
            }
        })
    }

    // Get sender id (called by worker to get sender id for sending response)
    static getsender_id() {
        return this.#sender_id
    }

    // Link a service from worker, allow it 
    static linkWorkerService<T>(serviceName: string, worker: SharedWorker) {
        if (!this.#workers.has(worker)) {
            const requests = new Map<RequestId, {
                o: Subscriber<any>
            }>()
            this.#workers.set(worker, requests)
            worker.port.start()
            fromEvent<MessageEvent<RpcResponse>>(worker.port as unknown as EventTarget, 'message').pipe(
                tap(e => {
                    const { id, data, error, completed } = e.data
                    const request = requests.get(id)
                    if (!request) return
                    data && request.o.next(data)
                    completed && request.o.complete();
                    (error || completed) && requests.delete(id)
                    error && request.o.error(new Error(error))
                }),
                takeUntil(fromEvent(worker.port as unknown as EventTarget, 'messageerror'))
            ).subscribe()
        }

        const createResult = (methodPath: string, args: any[]): ThenableObservable<any> => {
            const id = crypto.randomUUID()
            const requests = this.#workers.get(worker)!

            const observable = new Observable<any>(o => {
                requests.set(id, { o })
                return () => requests.delete(id)
            })

            setTimeout(() => worker.port.postMessage({
                id,
                service: serviceName,
                method: methodPath,
                args,
                sender_id: this.#sender_id
            }))

            return Object.assign(observable, {
                then(onFulfilled?: (value: any) => any, onRejected?: (reason: any) => any) {
                    return firstValueFrom(observable).then(onFulfilled, onRejected)
                }
            }) as ThenableObservable<any>
        }

        const buildProxy = (path: string[]): any => {
            const callable = (...args: any[]) => {
                const methodPath = path.join('/')
                if (!methodPath) throw new Error('Cannot call root proxy directly')
                return createResult(methodPath, args)
            }

            return new Proxy(callable, {
                get: (_, prop) => {
                    if (prop === 'then') {
                        const methodPath = path.join('/')
                        if (!methodPath) return undefined
                        return (onFulfilled?: (value: any) => any, onRejected?: (reason: any) => any) => {
                            return createResult(methodPath, []).then(onFulfilled, onRejected)
                        }
                    }
                    if (prop === 'subscribe') {
                        const methodPath = path.join('/')
                        if (!methodPath) return undefined
                        return (...subArgs: any[]) => createResult(methodPath, []).subscribe(...subArgs)
                    }
                    if (typeof prop !== 'string') return undefined
                    return buildProxy([...path, prop])
                },
                apply: (_target, _thisArg, argArray: any[]) => {
                    const methodPath = path.join('/')
                    if (!methodPath) throw new Error('Cannot call root proxy directly')
                    return createResult(methodPath, argArray)
                }
            })
        }

        return buildProxy([]) as T
    }

}
