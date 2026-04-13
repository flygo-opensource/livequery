import { BehaviorSubject, filter, mergeMap, Subject, takeUntil } from "rxjs";
import type { RpcChannel, RpcMessage } from "./RpcChannel";

function isObservableLike(value: unknown): value is { pipe: (...args: any[]) => any } {
    return !!value && typeof value === 'object' && typeof (value as any).pipe === 'function'
}

export class WorkerManager {

    #services = new BehaviorSubject(new Map<string, any>())
    #stopper$ = new Subject<number>()

    async #call<T>(target: any, paths: string[], args: any[]): Promise<T | null> {
        const [first, ...rest] = paths
        if (!first || first == '#') return target
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

    constructor(private channel: RpcChannel) {
        this.channel.pipe(
            mergeMap(async ({ id, cancel, request, respond }) => {
                if (cancel) {
                    this.#stopper$.next(id)
                    return
                }
                if (!request) return
                const post = (response: RpcMessage['response']) => respond({ id, response })
                const service = this.#services.getValue().get(request.service)
                if (!service) return post({ error: `Service ${request.service} not found` })
                try {
                    const result = await this.#call<any>(service, request.method, request.args)
                    if (isObservableLike(result)) {
                        result.pipe(
                            takeUntil(this.#stopper$.pipe(
                                filter(stop_id => stop_id === id)
                            ))
                        ).subscribe(
                            (data: any) => post({ data }),
                            (err: any) => post({ error: err?.message ?? String(err), completed: true }),
                            () => post({ completed: true })
                        )
                    } else {
                        const data = await Promise.resolve(result)
                        post({ data, completed: true })
                    }
                } catch (err: any) {
                    post({ error: err?.message ?? String(err) })
                }
            })
        ).subscribe()
    }

    exposeService(name: string, service: any) {
        const services = this.#services.getValue()
        services.set(name, Object.assign(service, {
            ____initialize____: () => {
                return Object.entries(services).reduce((p, [k, v]) => {
                    if (v instanceof BehaviorSubject) {
                        return {
                            ...p,
                            [k]: v.getValue()
                        }
                    }
                    return p
                }, {} as Record<string, any>)
            }
        }))
        this.#services.next(services)
    }



}