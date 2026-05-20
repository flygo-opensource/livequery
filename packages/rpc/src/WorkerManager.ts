import { BehaviorSubject, filter, finalize, map, mergeMap, Subscription } from "rxjs";
import type { RpcChannel } from "./RpcChannel.js";

function isObservableLike(value: unknown): value is { pipe: (...args: any[]) => any } {
    return !!value && typeof value === 'object' && typeof (value as any).pipe === 'function'
}

export class WorkerManager {

    #services = new BehaviorSubject(new Map<string, any>())



    async #call<T>(target: any, paths: string[], args: any[]): Promise<T | null> {
        const [first, ...rest] = paths
        if (!first || first == '#') throw new Error(`Invalid method path: ${paths.join('.')}`)
        if (target == null) throw new Error(`Invalid method path: ${paths.join('.')}`)
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
        const responses = new Map<number, Subscription>()

        this.channel.pipe(
            map(({ id, cancel, request, respond }) => {
                if (cancel) {
                    const subscription = responses.get(cancel.id)
                    if (subscription) {
                        subscription.unsubscribe()
                        responses.delete(cancel.id)
                    }
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
                try {
                    const result = await this.#call<any>(service, request.method, request.args)
                    if (isObservableLike(result)) {
                        const subscription = result.pipe(
                            finalize(() => {
                                responses.delete(id)
                            })
                        ).subscribe(
                            (data: any) => respond({ data }),
                            (err: any) => respond({ error: err?.message ?? String(err), completed: true }),
                            () => respond({ completed: true })
                        )
                        responses.set(id, subscription)
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
            })
        ).subscribe()
    }

    exposeService(name: string, service: any) {
        const services = this.#services.getValue()
        services.set(name, Object.assign(service))
        this.#services.next(services)
    }



}
