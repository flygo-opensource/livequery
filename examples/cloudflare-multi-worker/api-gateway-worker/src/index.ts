import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { LIVEQUERY_REALTIME_PATH, LivequeryRequestParser, type UpdatedDataType } from '@livequery/core/workers'
import { authenticate } from '../../shared/authenticate.js'
import { matchGatewayRoute, type GatewayRoute } from '../../shared/routes.js'
import { createRealtime } from './createRealtime.js'

// The Durable Object class must be a named export of the Worker module.
export { RealtimeGatewayDO } from './RealtimeGatewayDO.js'

type AppEnv = { Bindings: GatewayEnv; Variables: { principal: string } }

const WRITE_TYPES: Record<string, UpdatedDataType> = {
    POST: 'added',
    PUT: 'modified',
    PATCH: 'modified',
    DELETE: 'removed',
}

const app = new Hono<AppEnv>()

app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'x-lcid', 'x-lgid'],
}))

app.get('/health', c => c.json({ ok: true, worker: 'api-gateway-worker' }))

app.use('/livequery/*', async (c, next) => {
    const principal = await authenticate(c.req.raw, c.env)
    if (!principal) return c.json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } }, 401)
    c.set('principal', principal)
    await next()
})

// ─── Realtime ───────────────────────────────────────────────────────────────

app.get(LIVEQUERY_REALTIME_PATH, c => createRealtime(c.env).router.fetch(c.req.raw, c.get('principal')))

// ─── Service API proxy ──────────────────────────────────────────────────────

app.all('*', async c => {
    const route = matchGatewayRoute(c.req.method, c.req.path)
    if (!route) return c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404)

    const service = route.binding === 'TASKS_SERVICE' ? c.env.TASKS_SERVICE : c.env.INCIDENTS_SERVICE
    const response = await service.fetch(c.req.raw)
    if (response.ok) await syncRealtime(c, route, response)
    return response
})

app.onError((error, c) => {
    console.error(JSON.stringify({ event: 'gateway_request_failed', message: String(error) }))
    return c.json({ error: { code: 'BAD_GATEWAY', message: 'Upstream service failed' } }, 502)
})

/**
 * Realtime lives in the gateway, so services stay plain REST workers:
 *   - after a successful read, register the caller's socket (x-lcid / x-lgid) for that ref;
 *   - after a successful write, publish the item the service returned.
 * Writes that bypass the gateway (queues, cron) must publish themselves.
 */
async function syncRealtime(c: Context<AppEnv>, route: GatewayRoute, response: Response): Promise<void> {
    const { ref, collection_ref } = parseRef(c.req.path, route)
    const { publisher } = createRealtime(c.env)

    if (c.req.method === 'GET') {
        const client_id = c.req.header('x-lcid')
        const gateway_id = c.req.header('x-lgid')
        if (!client_id || !gateway_id) return
        // Awaited before responding, so no change slips between the read and the registration.
        const accepted = await publisher
            .register({ ref, client_id, gateway_id, listener_node_id: gateway_id }, c.get('principal'))
            .catch(() => false)
        if (!accepted) console.warn(JSON.stringify({ event: 'realtime_subscribe_rejected', ref }))
        return
    }

    const type = WRITE_TYPES[c.req.method]
    const body = await response.clone().json().catch(() => undefined) as { item?: { id?: unknown } } | undefined
    const item = body?.item
    if (!type || typeof item?.id !== 'string') return
    // waitUntil keeps the Worker alive for the fan-out after the response is sent.
    const update = { ref: collection_ref, type, data: { ...item, id: item.id } }
    c.executionCtx.waitUntil(publisher.publish(update).catch(e => {
        console.error(JSON.stringify({ event: 'realtime_publish_failed', ref: collection_ref, message: String(e) }))
    }))
}

function parseRef(pathname: string, route: GatewayRoute): { ref: string; collection_ref: string } {
    const parsed = LivequeryRequestParser.parse({
        path: pathname,
        ref: route.path,
        method: route.method,
        params: {},
        query: {},
        headers: new Map(),
    })
    const ref = parsed?.ref ?? pathname.replace(/^\/livequery\//, '')
    return { ref, collection_ref: parsed?.collection_ref ?? ref }
}

export default app
