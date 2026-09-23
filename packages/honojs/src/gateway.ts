import type { Context, Env, MiddlewareHandler } from 'hono'
import {
    LIVEQUERY_CHANGE_HEADER,
    LIVEQUERY_REF_HEADER,
    matchService,
    type MatchedService,
    type ServiceRouting,
    type UpdatedData,
    type UpdatedDataType,
} from '@livequery/core'
import type { LivequeryRealtimeTarget } from './realtimeMiddleware.js'

type Fetcher = { fetch(request: Request): Promise<Response> }

export type LivequeryGatewayOptions<E extends Env = any> = {
    /**
     * Which service owns which path prefix, and how to reach each one. A function is asked on every
     * request — for routing that changes while the gateway runs, such as `discoverServices()` from
     * `@livequery/discovery`, which learns services over UDP on Node and Bun.
     */
    routing: ServiceRouting | (() => ServiceRouting)
    /** Where realtime work goes; omit for a gateway that only proxies. */
    realtime?: LivequeryRealtimeTarget<E>
    /** Identity of the caller, passed to `register` so a socket cannot be subscribed by others. */
    principal?: (c: Context<E>) => string | undefined
    /**
     * A request to a service failed before any answer (connection refused, reset, DNS). The error
     * still propagates; this is for routing that can take the service out — `discoverServices()`'s
     * `unreachable`.
     */
    onServiceError?: (service: MatchedService, error: unknown) => void
}

const CHANGE_TYPES = new Set<UpdatedDataType>(['added', 'modified', 'removed'])

function isGateway(target: LivequeryRealtimeTarget): target is Extract<LivequeryRealtimeTarget, { id: string }> {
    return typeof (target as { listen?: unknown }).listen === 'function'
}

function resolve<E extends Env>(c: Context<E>, service: MatchedService): Fetcher {
    const binding = service.target.binding
        ? (c.env as Record<string, unknown>)[service.target.binding] as Fetcher | undefined
        : undefined
    if (binding) return binding

    const base = service.target.url
    if (!base) {
        throw new Error(`Service "${service.name}" has neither a bound "${service.target.binding}" nor a url`)
    }
    return {
        fetch(request: Request) {
            const url = new URL(request.url)
            const target = new URL(url.pathname + url.search, base)
            return fetch(new Request(target, request))
        },
    }
}

/** Strip the realtime headers before the response leaves the gateway; they are internal. */
function clean(response: Response): Response {
    if (!response.headers.has(LIVEQUERY_REF_HEADER) && !response.headers.has(LIVEQUERY_CHANGE_HEADER)) {
        return response
    }
    const headers = new Headers(response.headers)
    headers.delete(LIVEQUERY_REF_HEADER)
    headers.delete(LIVEQUERY_CHANGE_HEADER)
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

/**
 * Proxy Livequery requests to the service that owns their path prefix, and run realtime on their
 * behalf.
 *
 *   app.use('*', gateway({ routing, realtime: shards, principal: c => c.get('principal') }))
 *
 * Routing is by prefix, so a service can add routes under its own prefix without a gateway
 * deploy. The service reports what realtime should do through two response headers —
 * `x-livequery-ref` after a read, `x-livequery-change` after a write — which the gateway acts on
 * and then strips. A path no service owns falls through to the next handler.
 */
export function gateway<E extends Env = any>(options: LivequeryGatewayOptions<E>): MiddlewareHandler<E, any> {
    const { routing, realtime, principal, onServiceError } = options

    return async (c, next) => {
        const service = matchService(typeof routing === 'function' ? routing() : routing, c.req.path)
        if (!service) return next()

        const response = await resolve(c, service).fetch(c.req.raw).catch(error => {
            onServiceError?.(service, error)
            throw error
        })
        if (!response.ok || !realtime) return clean(response)

        try {
            await sync(c, response, realtime, principal?.(c))
        } catch (e) {
            // Realtime is best effort; the service already did the work.
            console.error('livequery: gateway realtime failed', e)
        }
        return clean(response)
    }
}

// ── Internal ───────────────────────────────────────────────────────────────────

async function sync<E extends Env>(
    c: Context<E>,
    response: Response,
    target: LivequeryRealtimeTarget<E>,
    principal: string | undefined
): Promise<void> {
    const ref = response.headers.get(LIVEQUERY_REF_HEADER)
    if (ref) {
        const client_id = c.req.header('x-lcid') ?? c.req.header('socket_id')
        if (!client_id) return
        if (isGateway(target)) {
            target.listen([{
                ref,
                client_id,
                gateway_id: c.req.header('x-lgid') ?? target.id,
                listener_node_id: target.id,
            }])
            return
        }
        const gateway_id = c.req.header('x-lgid')
        if (!gateway_id || !target.register) return
        await target.register({ ref, client_id, gateway_id, listener_node_id: gateway_id }, c)
        return
    }

    const change = response.headers.get(LIVEQUERY_CHANGE_HEADER)
    if (!change) return
    const [type, change_ref] = change.split(' ')
    if (!change_ref || !CHANGE_TYPES.has(type as UpdatedDataType)) return

    // The item lives in the service's response body, which is the only copy the gateway has.
    const body = await response.clone().json().catch(() => undefined) as { item?: { id?: unknown } } | undefined
    const item = body?.item
    if (typeof item?.id !== 'string') return

    const update: UpdatedData = { ref: change_ref, type: type as UpdatedDataType, data: item as { id: string } }
    if (isGateway(target)) {
        target.next(update)
        return
    }
    if (target.publish) await target.publish(update, c)
}
