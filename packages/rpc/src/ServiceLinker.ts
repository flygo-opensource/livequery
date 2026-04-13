import { BehaviorSubject, finalize, firstValueFrom, Observable, ReplaySubject, Subject, tap } from "rxjs";
import type { RpcChannel } from "./RpcChannel";
import type { WorkerService } from "./WorkerService";

type ThenableObservable<T> = Observable<T> & PromiseLike<T>

export class ServiceLinker {

    #request_id = 1
    #services = new Map<string, any>()
    #requests = new Map<number, {
        o: Subject<any>
    }>

    constructor(private channel: RpcChannel) {
        this.channel.pipe(
            tap(e => {
                if (!e.response) return
                const request = this.#requests.get(e.id)
                if (!request) return
                const { completed, data, error } = e.response
                if (completed || error) this.#requests.delete(e.id)
                data && request.o.next(data)
                completed && request.o.complete(); 
                error && request.o.error(new Error(error))
            })
        ).subscribe()
    }

    linkService<T>(name: string): WorkerService<T> {
        const cache = this.#services.get(name)
        if (cache) return cache

        const behavior_subjects = new Map<string, BehaviorSubject<any>>()
        const ready$ = new BehaviorSubject(false)

        const rpc = <T = any>(paths: string[], args: any[]): ThenableObservable<T> => {
            const id = this.#request_id++
            const o = new Subject<any>()
            this.#requests.set(id, { o })
            const observable = o.pipe(
                finalize(() => {
                    if (!this.#requests.has(id)) return
                    this.#requests.delete(id)
                    this.channel.send({
                        id,
                        cancel: true,
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

        const assert = (id: string, value: any = null) => {
            const saved = behavior_subjects.get(id)!
            if (saved) return saved
            const channel = new BehaviorSubject(value)
            behavior_subjects.set(id, channel)
            rpc([id], []).subscribe({
                next(value) {
                    channel.next(value)
                },
            })
            return channel
        }

        const build = (paths: string[] = []) => {
            const fn = (...args: any[]) => rpc(paths, args)
            return new Proxy(fn, {
                get: (_, prop) => {
                    if (prop == 'then' || typeof prop != 'string') {
                        return (s: Function) => firstValueFrom(ready$).then(v => s(v))
                    }
                    if (prop == 'pipe' || prop == 'subscribe' || prop == 'getValue') {
                        const id = [...paths].pop() || '#'
                        if (prop == 'getValue' || behavior_subjects.has(id)) {
                            const channel = assert(id)
                            return (...args: any[]) => channel[prop](...args)
                        }
                        return (...args: any[]) => rpc(paths, []).pipe()[prop](...args)
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
                assert(key, value)
            }
            ready$.next(true)
        })
        this.#services.set(name, service)
        return service
    }

}