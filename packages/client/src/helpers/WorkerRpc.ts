import { BehaviorSubject, EMPTY, filter, finalize, firstValueFrom, from, fromEvent, lastValueFrom, map, mergeMap, Observable, scan, Subject, takeUntil, tap, type Subscriber } from "rxjs";
import { SmartCache } from "./SmartCache";

export type RpcContext = {
    tab_id: string
    caller_id: string
}

export type RpcRequest = RpcContext & {
    id: number
    cancel?: boolean
    service: string
    method: string
    args: any[]
}

export type RpcResponse = {
    id: number;
    data?: any
    error?: string
    completed: boolean
}

export type RequestId = number

type ThenableObservable<T> = Observable<T> & PromiseLike<T>


function isObservableLike(value: unknown): value is { pipe: (...args: any[]) => any } {
    return !!value && typeof value === 'object' && typeof (value as any).pipe === 'function'
}


const WorkerContext = typeof window !== 'undefined' ? null : globalThis as any as SharedWorkerGlobalScope

export const TAB_ID = Math.random().toString(36).slice(2, 10)

export type WorkerService<T> = {
    [k in keyof T]: (
        T[k] extends BehaviorSubject<infer U> ? BehaviorSubject<U> : (
            T[k] extends Observable<infer U> ? Observable<U> : (
                T[k] extends <G>(...args: infer Args) => infer R ? (
                    <G>(...args: Args) => (
                        Awaited<R> extends Observable<any> ? R : Promise<R>
                    )
                ) : (
                    T[k] extends object ? T[k] : never
                )
            )
        )
    )
}


declare const window: Window & {
    [key: string]: any
}


export class WorkerRpc {
    static #CALLER_ID = Math.random().toString(36).slice(2, 10)

    static #requests = new Map<RequestId, {
        o: Subject<any>
    }>()
    #services = new Map<string, any>()

    constructor() {
        this.#initialize()
    }

    static async #call<T>(target: any, paths: string[], args: any[]): Promise<T | null> {
        const [first, ...rest] = paths
        if (!first) throw new Error(`INVAILD_RPC_METHOD`)
        if (rest.length == 0) {
            const prop = target[first]
            if (typeof prop == 'function') {
                return await prop.apply(target, args)
            } else {
                return prop
            }
        }
        return this.#call<T>(target[first], rest, args)
    }

    #initialize() {
        if (!WorkerContext) return
        const stopper$ = new Subject<number>()
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
            map(async ({ port, msg: { data: req } }) => {
                if (req.cancel) {
                    stopper$.next(req.id)
                    return
                }
                const service = this.#services.get(req.service)
                if (!service) return

                const result = await WorkerRpc.#call<any>(service, req.method.split('/'), req.args)
                const post = (data: RpcResponse) => {
                    port.postMessage(data)
                }
                const id = req.id
                try {
                    if (isObservableLike(result)) {
                        result.pipe(
                            takeUntil(stopper$.pipe(
                                filter(stop_id => stop_id === id)
                            ))
                        ).subscribe(
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
        const behavior_subjects = Object.keys(instance).reduce((p, k) => {
            const is_behavior_subject = typeof instance[k].getValue === 'function'
            if (is_behavior_subject) {
                return {
                    ...p,
                    [k]: instance[k].getValue()
                }
            }
            return p
        }, {} as Record<string, any>)

        this.#services.set(serviceName, Object.assign(instance, {
            __initialize: () => behavior_subjects
        }))
        console.log(`Service "${serviceName}" exposed to workers`)
    }

    static getContext(instance: any) {
        return instance?.__RPC_CONTEXT__
    }

    // Link a service from worker, allow it 
    static #backgroundServices = new SmartCache()

    static #worker_inited = false
    static #request_id = 1
    static linkWorkerService<T>(name: string, worker:  SharedWorker) {

        if (!this.#worker_inited) {
            this.#worker_inited = true
            worker.port.start()
            fromEvent<MessageEvent<RpcResponse>>(worker.port as unknown as EventTarget, 'message').pipe(
                tap(e => {
                    const { id, data, error, completed } = e.data
                    const request = this.#requests.get(id) 
                    if (!request) return
                    if (error || completed) {
                        this.#requests.delete(id)
                    }
                    data && request.o.next(data)
                    completed && request.o.complete();
                    error && request.o.error(new Error(error))
                }),
                takeUntil(fromEvent(worker.port as unknown as EventTarget, 'messageerror')),
                finalize(() => {
                    console.log(`Worker disconnected, cleaning up linked services`)
                    worker.port.close()
                })
            ).subscribe()

        }



        return this.#backgroundServices.resolve<WorkerService<T> & { __initialize: () => Promise<void> }>(name, () => {

            const channels = new Map<string, BehaviorSubject<any>>()


            const rpc = <T = any>(paths: string[], args: any[]): ThenableObservable<T> => {
                const id = this.#request_id++
                const o = new Subject<any>()
                this.#requests.set(id, { o })
                const observable = o.pipe(
                    finalize(() => {
                        if (!this.#requests.has(id)) return
                        this.#requests.delete(id)
                        const req: RpcRequest = {
                            id,
                            cancel: true,
                            service: name,
                            method: paths.join('/'),
                            args,
                            tab_id: TAB_ID,
                            caller_id: WorkerRpc.#CALLER_ID
                        }
                        worker.port.postMessage(req)
                    })
                )
                setTimeout(() => {
                    const req: RpcRequest = {
                        id,
                        service: name,
                        method: paths.join('/'),
                        args,
                        tab_id: TAB_ID,
                        caller_id: WorkerRpc.#CALLER_ID
                    }
                    worker.port.postMessage(req)
                })

                return Object.assign(observable, {
                    then(onFulfilled?: (value: any) => any, onRejected?: (reason: any) => any) {
                        return firstValueFrom(observable, { defaultValue: { data: null } }).then(onFulfilled, onRejected)
                    }
                }) as ThenableObservable<any>
            }

            const assert = (id: string, value: any = null) => {
                const saved = channels.get(id)!
                if (saved) return saved
                const channel = new BehaviorSubject(value)
                channels.set(id, channel)
                rpc([id], []).subscribe({
                    next(value) {
                        channel.next(value)
                    },
                })
                return channel
            }

            const __initialize = async () => {
                const states = await rpc<Record<string, any>>(['__initialize'], [])
                for (const [key, value] of Object.entries(states)) {
                    assert(key, value)
                }
                return states
            }

            const build = (paths: string[] = []) => {
                const fn = (...args: any[]) => rpc(paths, args)
                return new Proxy(fn, {
                    get: (_, prop) => {
                        if (prop == 'then' || typeof prop != 'string') return null
                        if (prop == 'pipe' || prop == 'subscribe' || prop == 'getValue') {
                            const id = [...paths].pop()!
                            if (!id) throw new Error(`Cannot access property "${prop}" on root service proxy`)
                            const channel = assert(id)
                            return (...args: any[]) => channel[prop](...args)
                        }
                        if (prop == '__initialize') return __initialize
                        return build([...paths, prop])
                    },
                    has(target, prop) {
                        if (prop == 'pipe' || prop == 'subscribe' || prop == 'getValue') {
                            return true
                        }
                        return prop in fn
                    }
                }) as T
            }
            return build() as any
        })
    }
}

