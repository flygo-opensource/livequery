import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import * as z from 'zod/mini'
import { LIVEQUERY_REALTIME_PATH } from '@livequery/core/workers'
import { errorHandler, livequery, realtime, validator } from '@livequery/honojs'
import { d1 } from '@livequery/d1'
import { createRealtime } from './createRealtime.js'
import { requireAuth } from './requireAuth.js'
import type { AppEnv } from './types.js'

// The Durable Object class must be a named export of the Worker module.
export { RealtimeGatewayDO } from './RealtimeGatewayDO.js'

// ─── Schema ─────────────────────────────────────────────────────────────────
//
// One schema per resource: it validates writes and doubles as the column allowlist that `d1()`
// enforces on filters, sorts and writes. Nothing outside it can reach SQL.

// strictObject: an unknown body field is a client bug, so reject it instead of dropping it.
// zod/mini has no `.partial()` method, so PATCH gets its schema explicitly.
const Task = z.strictObject({
    title: z.string().check(z.minLength(1)),
    status: z._default(z.enum(['todo', 'done']), 'todo'),
    created_at: z.optional(z.int()),
})
const TaskPatch = z.partial(Task)

// ─── App ────────────────────────────────────────────────────────────────────

const app = new Hono<AppEnv>()

app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'x-lcid', 'x-lgid'],
}))
app.use('/livequery/*', requireAuth())

// ─── Realtime ───────────────────────────────────────────────────────────────
//
// Sockets live in sharded Durable Objects. Reads register through the publisher (awaited, so no
// change slips between the read and the registration); writes publish through waitUntil, which
// keeps the Worker alive for the fan-out after the response is sent.

app.get(LIVEQUERY_REALTIME_PATH, c => createRealtime(c.env).router.fetch(c.req.raw, c.get('principal')))

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

// ─── Routes ─────────────────────────────────────────────────────────────────
//
// validator → livequery → d1 → realtime: validate the input, parse the Livequery request, run the
// D1 operation, then subscribe or publish. `d1()` reads the table from the collection ref.

app.get('/livequery/tasks', validator(Task, { patch: TaskPatch }), livequery(), d1(), realtime(shards))
app.post('/livequery/tasks', validator(Task, { patch: TaskPatch }), livequery(), d1(), realtime(shards))
app.get('/livequery/tasks/:id', validator(Task, { patch: TaskPatch }), livequery(), d1(), realtime(shards))
app.put('/livequery/tasks/:id', validator(Task, { patch: TaskPatch }), livequery(), d1(), realtime(shards))
app.patch('/livequery/tasks/:id', validator(Task, { patch: TaskPatch }), livequery(), d1(), realtime(shards))
app.delete('/livequery/tasks/:id', livequery(), d1({ fields: Object.keys(Task.shape) }), realtime(shards))

// Tasks filtered by status — the :status route key becomes WHERE status = ?
app.get('/livequery/status/:status/tasks', validator(Task, { patch: TaskPatch }), livequery(), d1(), realtime(shards))

// ─── Errors ─────────────────────────────────────────────────────────────────
//
// 4xx keeps its code and message; 5xx is logged and answered generically, so a D1 error never
// leaks SQL to the client.

app.onError(errorHandler())

export default app
