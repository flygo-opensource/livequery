import { EMPTY, finalize, firstValueFrom, fromEvent, map, mergeMap, Observable, takeUntil, tap, type Subscriber } from "rxjs";


export type RpcRequest = {
    id: string;
    service: string
    method: string
    args: any[]
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


const WorkerContext = typeof window !== 'undefined' ? null : globalThis as any as SharedWorkerGlobalScope



export class WorkerRpc {

    static #workers = new Map<SharedWorker, Map<RequestId, {
        o: Subscriber<any>
    }>>()
    #services = new Map<string, any>()

    constructor() {
        this.#initialize()
    }

    #initialize() {
        if (!WorkerContext) return
        fromEvent<MessageEvent>(WorkerContext, 'connect').pipe(
            mergeMap(e => {
                const port = e.ports[0]
                if (!port) return EMPTY
                port.start()
                return fromEvent<MessageEvent<RpcRequest>>(port, 'message').pipe(
                    takeUntil(fromEvent(port, 'messageerror')),
                    map(msg => ({ port, msg })),
                    finalize(() => {
                        console.log(`Worker disconnected, cleaning up linked services`)
                        port.close()
                    })
                )
            }),
            map(async ({ port, msg }) => {
                const { id, service, method, args } = msg.data
                if (!id || !service || !method) return

                const svc = this.#services.get(service)
                if (!svc) return

                const post = (data: RpcResponse) => port.postMessage(data)
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
        ).subscribe()
    }

    exposeWorkerService(instance: any, name?: string) {
        if (!WorkerContext) return
        const serviceName = name || instance?.constructor?.name
        if (!serviceName) throw new Error('Service instance must have a constructor name')
        this.#services.set(serviceName, instance)
        console.log(`Service "${serviceName}" exposed to workers`)
    }

    // Link a service from worker, allow it 
    static linkWorkerService<T>(serviceName: string, worker: SharedWorker) {
        console.log(`Linking service "${serviceName}" from worker`)
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
                takeUntil(fromEvent(worker.port as unknown as EventTarget, 'messageerror')),
                finalize(() => {
                    console.log(`Worker disconnected, cleaning up linked services`)
                    this.#workers.delete(worker)
                    worker.port.close()
                })
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
                args
            }))

            return Object.assign(observable, {
                then(onFulfilled?: (value: any) => any, onRejected?: (reason: any) => any) {
                    return firstValueFrom(observable, { defaultValue: { data: null } }).then(onFulfilled, onRejected)
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
