/**
 * API gateway — the same file on Node and on Bun.
 *
 *   node examples/api-gateway/gateway.ts
 *   bun  examples/api-gateway/gateway.ts
 *
 * Clients talk only to this process: HTTP goes to the service that owns the path prefix, and the
 * WebSocket at /livequery/realtime-updates is served by the in-process realtime gateway that
 * `realtimeGateway()` builds for the current runtime (`ws` on Node, `Bun.serve` on Bun).
 */
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { LIVEQUERY_REALTIME_PATH, type ServiceRouting } from '@livequery/core'
import { errorHandler, gateway, realtimeGateway, serve } from '@livequery/honojs'
import { discoverServices } from '@livequery/discovery'
import { DISCOVERY, GATEWAY_PORT, SERVICE_URL } from './shared/config.ts'
import declared from './shared/routing.json' with { type: 'json' }

const realtime = await realtimeGateway()

// Prefix routing: the service owns everything under /livequery/tasks, so it can add routes
// without a gateway restart. Either declared (routing.json, the address from the environment), or
// learned from the services' own announcements over UDP — then adding a service, or a second
// instance of one, needs no gateway change at all.
const routing: ServiceRouting | (() => ServiceRouting) = DISCOVERY
    ? discoverServices().routing
    : { ...declared, services: { ...declared.services, tasks: { ...declared.services.tasks, url: SERVICE_URL } } }

const app = new Hono()
app.onError(errorHandler())

// The browser client sends x-lcid / x-lgid on every request, so preflight must allow them.
app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'x-lcid', 'x-lgid'],
}))

app.get('/health', c => c.json({ ok: true, kind: 'gateway', gateway_id: realtime.id }))
app.get(LIVEQUERY_REALTIME_PATH, c => c.text('Expected WebSocket', 426))
app.use('*', gateway({ routing, realtime }))
app.notFound(c => c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404))

console.log(JSON.stringify({ event: 'ready', kind: 'gateway', port: GATEWAY_PORT }))
export default serve(app, { port: GATEWAY_PORT, realtime })
