import { BehaviorSubject, combineLatest, defer, finalize, firstValueFrom, lastValueFrom, map, merge, Observable, Subject, tap } from "rxjs";
import type { RpcChannel } from "./RpcChannel";
import type { WorkerService } from "./WorkerService";

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

        const behaviot_subject_values = new Map<string, any>()
        const behavior_subjects = new Map<string, BehaviorSubject<any>>()
        const ready$ = new BehaviorSubject(false)

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
                    if (prop == '###READY###') return ready$
                    if (behavior_subjects.has(prop)) return behavior_subjects.get(prop)!
                    if (prop == 'pipe' || prop == 'subscribe' || prop == 'getValue') {
                        const key = paths.join('.')
                        const cache = behavior_subjects.get(key) || new BehaviorSubject(behaviot_subject_values.get(key) ?? null)
                        if (!behavior_subjects.has(key)) {
                            behavior_subjects.set(key, cache)
                            rpc(paths, []).subscribe(v => cache.next(v))
                        }
                        return (...args: any) => cache[prop](...args)
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
        rpc<Record<string, any>>(['____initialize____'], []).then(states => {
            for (const [key, value] of Object.entries(states)) {
                behaviot_subject_values.set(key, value)
            }
            ready$.next(true)
        })
        this.#services.set(name, service)
        return service
    }

    static ready$(services: any) {
        return combineLatest(Object.values(services).map((s: any) => s['###READY###'] as Observable<boolean>)).pipe(
            map(status => status.every(Boolean))
        )
    }

}