import { BehaviorSubject, defer, finalize, firstValueFrom, Observable, ReplaySubject, share, Subject, tap, timer } from "rxjs";
import type { RpcChannel } from "./RpcChannel.js";
import type { WorkerService } from "./WorkerService.js";

type ThenableObservable<T> = Observable<T> & PromiseLike<T>


export class ServiceLinker {

    #request_id = 1
    #services = new Map<string, any>()
    #requests = new Map<number, {
        o: Subject<any>
        completed: boolean
    }>


    constructor(private channel: RpcChannel) {
        this.channel.pipe(
            tap(e => {
                if (!e.response) return
                const request = this.#requests.get(e.id)
                if (!request) return
                const { completed, data, error, stack } = e.response
                if (completed || error) request.completed = true
                if ("data" in e.response) {
                    request.o.next(data)
                }
                if (error) {
                    const err = new Error(error)
                    // Surface the worker-side stack for debugging instead of the (useless)
                    // foreground stack pointing at this rxjs callback.
                    if (stack) err.stack = stack
                    request.o.error(err)
                } else {
                    completed && request.o.complete()
                }
            })
        ).subscribe()

    }

    linkService<T>(name: string): WorkerService<T> {
        const cache = this.#services.get(name)
        if (cache) return cache

        const rpc = <T = any>(paths: string[], args: any[]): ThenableObservable<T> => {
            if (paths.length == 0 || paths[0] == '#') throw new Error(`Invalid method path: ${paths.join('.')}`)
            const id = this.#request_id++
            const o = new Subject<any>()
            this.#requests.set(id, { o, completed: false })
            const observable = o.pipe(
                finalize(() => {
                    const request = this.#requests.get(id)
                    this.#requests.delete(id)
                    if (!request || request.completed) return
                    setTimeout(() => {
                        this.channel.send({ id: 0, cancel: { id } })
                    })
                })
            )
            setTimeout(() => {
                this.channel.send({
                    id,
                    request: {
                        service: name,
                        method: paths,
                        args,
                    }
                })
            })
            return Object.assign(observable, {
                then(onFulfilled?: (value: any) => any, onRejected?: (reason: any) => any) {
                    return firstValueFrom(observable, { defaultValue: { data: null } }).then(onFulfilled, onRejected)
                }
            }) as ThenableObservable<any>
        }

        const values = new Map<string, any>()
        const observables = new Map<string, any>()

        const service = new Proxy({}, {
            get: (_, key) => {
                if (key == 'then' || typeof key != 'string') return null
                if (observables.has(key)) {
                    return Object.assign(observables.get(key), {
                        getValue: () => values.get(key)
                    })
                }
                const fn = (...args: any[]) => rpc([key], args)
                return new Proxy(fn, {
                    get: (_, prop) => {
                        if (prop == 'then' || typeof prop != 'string') return null
                        if (prop == 'pipe' || prop == 'subscribe') {
                            const $ = observables.get(key) || defer(() => rpc([key], [])).pipe(
                                tap(value => values.set(key, value)),
                                finalize(() => observables.delete(key)),
                                share({
                                    connector: () => new ReplaySubject(1),
                                    resetOnError: true,
                                    resetOnComplete: false,
                                    resetOnRefCountZero: () => timer(1000)
                                })
                            )
                            !observables.has(key) && observables.set(key, $)
                            return (...args: any[]) => $[prop](...args)
                        }
                        if (prop == 'getValue') return () => values.get(key)
                        return (...args: any[]) => rpc([key, prop], args)
                    }
                })
            },
            has(target, prop) {
                if (prop == 'pipe' || prop == 'subscribe' || prop == 'getValue') {
                    return true
                }
                return prop in target
            }
        }) as WorkerService<T>
        this.#services.set(name, service)
        return service
    }

}
