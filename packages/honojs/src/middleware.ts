import type { Env, MiddlewareHandler } from 'hono'
import type { LivequeryRealtimeSubscriber } from './realtime.js'
import { createLivequeryRequest } from './request.js'

export type LivequeryMiddlewareOptions<E extends Env = any> = {
    /** Registers the caller for realtime updates after a successful read. */
    realtime?: LivequeryRealtimeSubscriber<E>
    /** @deprecated Use `realtime`. */
    websocketGateway?: LivequeryRealtimeSubscriber<E>
    routePath?: string
}

export function livequery<E extends Env = any>(options: LivequeryMiddlewareOptions<E> = {}): MiddlewareHandler<E> {
    const realtime = options.realtime ?? options.websocketGateway
    return async (c, next) => {
        const requestOptions = options.routePath ? { routePath: options.routePath } : {}
        const livequeryRequest = await createLivequeryRequest(c, requestOptions)
        c.set('livequery' as never, livequeryRequest as never)

        await next()

        // Subscribe only after the handler succeeded: a read that failed (403, 404, validation)
        // must not leave the caller subscribed to data it could not read.
        if (!realtime || c.req.method !== 'GET' || !livequeryRequest || !c.res.ok) return
        const query = livequeryRequest.query ?? {}
        // Pagination requests are one-off fetches of an already subscribed ref.
        if (query[':after'] || query[':before'] || query[':around']) return

        const client_id = c.req.header('x-lcid') || c.req.header('socket_id')
        if (!client_id) return

        if (typeof realtime === 'function') {
            const gateway_id = c.req.header('x-lgid')
            if (!gateway_id) return
            const subscription = { ref: livequeryRequest.ref, client_id, gateway_id, listener_node_id: gateway_id }
            try {
                await realtime(subscription, c)
            } catch (e) {
                // Realtime is best effort; the read itself already succeeded.
                console.error('livequery: realtime subscription failed', e)
            }
            return
        }

        realtime.listen([{
            ref: livequeryRequest.ref,
            client_id,
            gateway_id: c.req.header('x-lgid') || realtime.id,
            listener_node_id: realtime.id,
        }])
    }
}
