import { BehaviorSubject, filter, finalize, map, mergeMap, Subject, takeUntil } from "rxjs";
import type { RpcChannel } from "./RpcChannel";

function isObservableLike(value: unknown): value is { pipe: (...args: any[]) => any } {
    return !!value && typeof value === 'object' && typeof (value as any).pipe === 'function'
}

export class WorkerManager {

    #services = new BehaviorSubject(new Map<string, any>())


    async #call<T>(target: any, paths: string[], args: any[]): Promise<T | null> {
        const [first, ...rest] = paths
        if (!first || first == '#') throw new Error(`Invalid method path: ${paths.join('.')}`)
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
        const running = new Set<number>()
        const stopper$ = new Subject<number>()

        this.channel.pipe(
            map(({ id, cancel, request, respond }) => {
                if (cancel) {
                    stopper$.next(cancel.id)
                    running.delete(cancel.id)
                    return
                }
                if (!request) return
                const service = this.#services.getValue().get(request.service)
                if (!service) return respond({ error: `Service ${request.service} not found` })
                if (request.method.length == 0 || request.method[0] == '#') {
                    respond({ error: `Can not call [${request.service}.${request.method.join('.')}]` })
                    return
                }
                return { request, id, respond, service }
            }),
            filter(Boolean),
            map(a => a!),
            mergeMap(async ({ id, request, respond, service }) => {
                running.add(id)
                try {
                    const result = await this.#call<any>(service, request.method, request.args)
                    if (!running.has(id)) return
                    if (isObservableLike(result)) {
                        result.pipe(
                            takeUntil(stopper$.pipe(
                                filter(stop_id => stop_id === id)
                            )),
                            finalize(() => {
                                running.delete(id)
                            })
                        ).subscribe(
                            (data: any) => respond({ data }),
                            (err: any) => respond({ error: err?.message ?? String(err), completed: true }),
                            () => respond({ completed: true })
                        )
                    } else {
                        const data = await result
                        respond({ data, completed: true })
                    }
                } catch (err: any) {
                    respond({
                        error: err?.message ?? String(err),
                        completed: true
                    })
                }
                running.delete(id)
            })
        ).subscribe()
    }

    exposeService(name: string, service: any) {
        const services = this.#services.getValue()
        services.set(name, Object.assign(service, {
            ____initialize____: () => {
                const states = Object.getOwnPropertyNames(service).reduce((p, k) => {
                    if (service[k] && typeof service[k].getValue === 'function') {
                        try {
                            return {
                                ...p,
                                [k]: service[k].getValue()
                            }
                        } catch { }
                    }
                    return p
                }, {} as Record<string, any>)
                return states
            }
        }))
        this.#services.next(services)
    }



}