import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { LIVEQUERY_CORS_HEADERS, LIVEQUERY_REALTIME_PATH, type ServiceRouting } from '@livequery/core/workers'
import { errorHandler, gateway } from '@livequery/honojs'
import { authenticate } from '../../shared/authenticate.js'
import routing from '../../shared/routing.json'
import { createRealtime } from './createRealtime.js'

// The Durable Object class must be a named export of the Worker module.
export { RealtimeGatewayDO } from './RealtimeGatewayDO.js'

type AppEnv = { Bindings: GatewayEnv; Variables: { principal: string } }

const app = new Hono<AppEnv>()

app.onError(errorHandler())

app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', ...LIVEQUERY_CORS_HEADERS],
}))

app.get('/health', c => c.json({ ok: true, worker: 'api-gateway-worker' }))

app.use('/livequery/*', async (c, next) => {
    const principal = await authenticate(c.req.raw, c.env)
    if (!principal) return c.json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } }, 401)
    c.set('principal', principal)
    await next()
})

// Client sockets live in sharded Durable Objects; the shard follows the principal.
app.get(LIVEQUERY_REALTIME_PATH, c => createRealtime(c.env).router.fetch(c.req.raw, c.get('principal')))

// Realtime on behalf of the services: they only annotate their responses.
const shards = {
    register: (subscription: Parameters<ReturnType<typeof createRealtime>['publisher']['register']>[0],
        c: Context<AppEnv>) => createRealtime(c.env).publisher.register(subscription, c.get('principal')),
    publish: (update: Parameters<ReturnType<typeof createRealtime>['publisher']['publish']>[0],
        c: Context<AppEnv>) => {
        c.executionCtx.waitUntil(createRealtime(c.env).publisher.publish(update).catch(e => {
            console.error(JSON.stringify({ event: 'realtime_publish_failed', message: String(e) }))
        }))
    },
}

// Prefix routing: each service owns everything under its prefix, so adding a route inside a
// service needs no gateway deploy. Only a new service does, because it needs a new binding.
app.use('*', gateway<AppEnv>({
    routing: routing as ServiceRouting,
    realtime: shards,
    principal: c => c.get('principal'),
}))

app.notFound(c => c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404))

export default app
