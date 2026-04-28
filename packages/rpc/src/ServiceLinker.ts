import { BehaviorSubject, EMPTY, finalize, firstValueFrom, lastValueFrom, merge, Observable, share, Subject, tap } from "rxjs";
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
        lastValueFrom(merge(
            this.channel.pipe(
                tap(e => {
                    if (!e.response) return
                    const request = this.#requests.get(e.id)
                    if (!request) return
                    const { completed, data, error } = e.response
                    if (completed || error) request.completed = true
                    data && request.o.next(data)
                    completed && request.o.complete();
                    error && request.o.error(new Error(error))
                })
            ),
        ))

    }

    linkService<T>(name: string): WorkerService<T> {
        const cache = this.#services.get(name)
        if (cache) return cache

        const observables = new Map<string, Observable<any>>()

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

        const build = (paths: string[] = []) => {
            const fn = (...args: any[]) => rpc(paths, args)
            return new Proxy(fn, {
                get: (_, prop) => {
                    if (prop == 'then' || typeof prop != 'string') return null
                    if (prop == 'pipe' || prop == 'subscribe' || prop == 'getValue') {
                        return (...args: any) => {
                            const key = paths.join('.')
                            const cache = observables.get(key)
                            if (cache) return cache
                            const sbj = new BehaviorSubject(null)
                            const observable = Object.assign(
                                rpc(paths, args).pipe(
                                    share({
                                        connector: () => sbj,
                                        resetOnRefCountZero: false,
                                        resetOnComplete: false,
                                        resetOnError: false,
                                    })
                                ),
                                {
                                    getValue: () => sbj.getValue()
                                }
                            )
                            observables.set(key, observable)
                            return observable
                        }
                    }
                    return build([...paths, prop])
                },
                has(target, prop) {
                    if (prop == 'pipe' || prop == 'subscribe' || prop == 'getValue') {
                        return true
                    }
                    return prop in target
                }
            }) as T
        }
        const service = build() as any
        this.#services.set(name, service)
        return service
    }

}