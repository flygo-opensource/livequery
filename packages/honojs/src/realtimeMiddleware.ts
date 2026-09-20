import type { Context, Env, MiddlewareHandler } from 'hono'
import {
    LIVEQUERY_VARS,
    type LivequeryRequest,
    type RealtimeSubscription,
    type UpdatedData,
    type UpdatedDataType,
} from '@livequery/core'

/** Header a service sets so its gateway can register the caller for the ref it just read. */
export const LIVEQUERY_REF_HEADER = 'x-livequery-ref'
/** Header a service sets after a write: `<type> <collection_ref>`, e.g. `modified tasks`. */
export const LIVEQUERY_CHANGE_HEADER = 'x-livequery-change'

/**
 * Where realtime work goes:
 *
 * - **omitted** — header mode. The service answers behind a gateway and only annotates the
 *   response; the gateway registers and publishes. Nothing else is needed on the service.
 * - **an in-process gateway** (`WebsocketGateway`, `BunWebsocketGateway`) — registers with
 *   `listen()` and publishes with `next()`, for a Node or Bun process that owns the sockets.
 * - **a pair of functions** — for Cloudflare Workers, where sockets live in a Durable Object:
 *   `{ register: (sub, c) => publisher.register(sub, principal), publish: (update, c) => ... }`.
 */
export type LivequeryRealtimeTarget<E extends Env = any> =
    | { id: string; listen(events: RealtimeSubscription[]): void; next(update: UpdatedData): void }
    | {
        register?(subscription: RealtimeSubscription, c: Context<E>): unknown
        publish?(update: UpdatedData, c: Context<E>): unknown
    }

const WRITE_TYPES: Record<string, UpdatedDataType> = {
    POST: 'added',
    PUT: 'modified',
    PATCH: 'modified',
    DELETE: 'removed',
}

function isGateway(target: LivequeryRealtimeTarget): target is Extract<LivequeryRealtimeTarget, { id: string }> {
    return typeof (target as { listen?: unknown }).listen === 'function'
}

function itemOf(result: unknown): { id: string } | undefined {
    const item = (result as { item?: { id?: unknown } } | undefined)?.item
    return typeof item?.id === 'string' ? item as { id: string } : undefined
}

/**
 * Subscribe the caller after a successful read, publish after a successful write.
 *
 *   app.get('/livequery/tasks', validator(Task), livequery(), d1(), realtime())
 *
 * Goes after the datasource middleware, which builds the response and then runs the rest of the
 * chain, so this only sees requests that really happened and can still add headers.
 *
 * Reads need `x-lcid` from the client, and pagination requests (`:after`, `:before`, `:around`)
 * are skipped: they re-read a ref the client is already subscribed to.
 */
export function realtime<E extends Env = any>(target?: LivequeryRealtimeTarget<E>): MiddlewareHandler<E, any> {
    return async (c, next) => {
        const req = c.get(LIVEQUERY_VARS.request as never) as LivequeryRequest | undefined
        if (!req) return next()
        // A datasource middleware calls next() only after its operation succeeded and has not
        // built a response yet. A handler that answered on its own may have failed, so skip it.
        // `c.res` is only safe to read once finalized: reading it earlier creates an empty one.
        if (c.finalized && !c.res.ok) return next()

        const method = (req.method ?? c.req.method).toUpperCase()
        try {
            if (method === 'GET') await register(c, req, target)
            else await publish(c, req, method, target)
        } catch (e) {
            // Realtime is best effort: the read or write already succeeded.
            console.error('livequery: realtime failed', e)
        }
        await next()
    }
}

// ── Internal ───────────────────────────────────────────────────────────────────

async function register<E extends Env>(
    c: Context<E>,
    req: LivequeryRequest,
    target?: LivequeryRealtimeTarget<E>
): Promise<void> {
    const client_id = c.req.header('x-lcid') ?? c.req.header('socket_id')
    if (!client_id) return
    const query = req.query ?? {}
    if (query[':after'] || query[':before'] || query[':around']) return

    if (!target) {
        c.header(LIVEQUERY_REF_HEADER, req.ref)
        return
    }

    if (isGateway(target)) {
        target.listen([{
            ref: req.ref,
            client_id,
            gateway_id: c.req.header('x-lgid') ?? target.id,
            listener_node_id: target.id,
        }])
        return
    }

    const gateway_id = c.req.header('x-lgid')
    if (!gateway_id || !target.register) return
    await target.register({ ref: req.ref, client_id, gateway_id, listener_node_id: gateway_id }, c)
}

async function publish<E extends Env>(
    c: Context<E>,
    req: LivequeryRequest,
    method: string,
    target?: LivequeryRealtimeTarget<E>
): Promise<void> {
    const type = WRITE_TYPES[method]
    const item = itemOf(c.get(LIVEQUERY_VARS.result as never))
    if (!type || !item) return
    // Changes are published on the collection ref; the gateway fans out to document subscribers.
    const ref = req.collection_ref ?? req.ref

    if (!target) {
        c.header(LIVEQUERY_CHANGE_HEADER, `${type} ${ref}`)
        return
    }
    const update: UpdatedData = { ref, type, data: item }
    if (isGateway(target)) {
        target.next(update)
        return
    }
    if (target.publish) await target.publish(update, c)
}
