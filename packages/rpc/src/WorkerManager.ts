import { BehaviorSubject, filter, finalize, map, mergeMap, Subscription } from "rxjs";
import type { RpcChannel } from "./RpcChannel.js";

function isObservableLike(value: unknown): value is { pipe: (...args: any[]) => any } {
    return !!value && typeof value === 'object' && typeof (value as any).pipe === 'function'
}

/**
 * Convert any thrown value into the wire-safe `{ code, message, stack }` shape.
 *
 * Fixes the "[object Object]" bug: the old code did `err?.message || String(err)`,
 * so an error with an EMPTY message (e.g. a backend error `{ code, message: '' }`)
 * fell through to `String(obj)` → "[object Object]". We now never stringify the
 * object blindly — we surface its real fields (code/name, JSON of own props) so
 * the main thread receives something legible. Always returns a structured-clone
 * safe plain object, so postMessage can't throw DataCloneError on a class error.
 */
export function serializeError(err: any): { code: string, message: string, stack?: string } {
    if (typeof err === 'string') return { code: 'InternalError', message: err }
    if (err && typeof err === 'object') {
        const code = String(err.code ?? err.name ?? 'InternalError')
        const message = (typeof err.message === 'string' && err.message) || (() => {
            try {
                const json = JSON.stringify(err)
                return json && json !== '{}' && json !== '[]' ? json : code
            } catch {
                return code
            }
        })()
        return { code, message, stack: typeof err.stack === 'string' ? err.stack : undefined }
    }
    return { code: 'InternalError', message: String(err) }
}

// Prototype-chain props that must never be reachable via a client-supplied method
// path — blocks `['constructor','constructor']` (Function constructor) and friends.
const FORBIDDEN_PROPS = new Set(['constructor', 'prototype', '__proto__'])

export class WorkerManager {

    #services = new BehaviorSubject(new Map<string, any>()) 

    async #call<T>(target: any, paths: string[], args: any[]): Promise<T | null> {
        const [first, ...rest] = paths
        if (!first || first == '#' || FORBIDDEN_PROPS.has(first)) throw new Error(`Invalid method path: ${paths.join('.')}`)
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
        const responses = new Map<number, { subscription: Subscription, connection_id?: string }>()

        this.channel.pipe(
            map(({ id, cancel, request, respond, disconnect, connection_id }) => {
                if (disconnect) {
                    // A connection dropped — release every streaming subscription it owned.
                    for (const [response_id, entry] of responses) {
                        if (entry.connection_id !== connection_id) continue
                        entry.subscription.unsubscribe()
                        responses.delete(response_id)
                    }
                    return
                }
                if (cancel) {
                    const entry = responses.get(cancel.id)
                    if (entry) {
                        entry.subscription.unsubscribe()
                        responses.delete(cancel.id)
                    }
                    return
                }
                if (!request) return
                const service = this.#services.getValue().get(request.service)
                if (!service) return respond({
                    error: {
                        code: 'ServiceNotFound',
                        message: `Service [${request.service}] not found`
                    }
                })
                if (request.method.length == 0 || request.method[0] == '#') {
                    respond({
                        error: {
                            code: 'InvalidMethodPath',
                            message: `Invalid method path: ${request.method.join('.')}`
                        }
                    })
                    return
                }
                return { request, id, respond, service, connection_id }
            }),
            filter(Boolean),
            map(a => a!),
            mergeMap(async ({ id, request, respond, service, connection_id }) => {
                try {
                    const result = await this.#call<any>(service, request.method, request.args)
                    if (isObservableLike(result)) {
                        const subscription = result.pipe(
                            finalize(() => {
                                responses.delete(id)
                            })
                        ).subscribe(
                            (data: any) => respond({ data }),
                            (error: any) => respond({
                                error: serializeError(error),
                                completed: true
                            }),
                            () => respond({ completed: true })
                        )
                        responses.set(id, { subscription, connection_id })
                    } else {
                        const data = await result
                        respond({ data, completed: true })
                    }
                } catch (err: any) {
                    respond({
                        error: serializeError(err),
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
