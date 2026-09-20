import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { LIVEQUERY_REALTIME_PATH } from '@livequery/core/workers'
import { D1Datasource } from '@livequery/d1'
import { broadcast } from './broadcast.js'
import { createRealtime } from './createRealtime.js'
import { livequery } from './middleware.js'
import { requireAuth } from './requireAuth.js'
import { subscribe } from './subscribe.js'
import type { AppEnv } from './types.js'

// The Durable Object class must be a named export of the Worker module.
export { RealtimeGatewayDO } from './RealtimeGatewayDO.js'

// ─── App ────────────────────────────────────────────────────────────────────

const app = new Hono<AppEnv>()
const ds = new D1Datasource()

app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] }))
app.use('/livequery/*', requireAuth())

// ─── Error handler ──────────────────────────────────────────────────────────

function apiError(e: unknown) {
    const err = (typeof e === 'object' && e !== null ? e : {}) as { status?: number; code?: string; message?: string }
    const status = typeof err.status === 'number' ? err.status : 500
    if (status >= 500) {
        // Database and runtime errors can carry SQL or internals; log them, never return them.
        console.error(JSON.stringify({ event: 'request_failed', message: String(err.message ?? e) }))
        return { status, body: { error: { code: 'INTERNAL', message: 'Internal error' } } }
    }
    return { status, body: { error: { code: err.code ?? 'BAD_REQUEST', message: err.message ?? 'Bad request' } } }
}

function fail(c: Context<AppEnv>, e: unknown) {
    const { status, body } = apiError(e)
    return c.json(body, status as never)
}

// ─── WebSocket → Durable Object shard ───────────────────────────────────────

app.get(LIVEQUERY_REALTIME_PATH, c => createRealtime(c.env).router.fetch(c.req.raw, c.get('principal')))

// ─── Route factory ──────────────────────────────────────────────────────────
//
// Creates all 5 HTTP verbs for a (collection, document) pair backed by one table.
// A successful GET registers the caller's socket (x-lcid / x-lgid) for that ref;
// writes publish the change to every realtime shard.

export function createRoutes(
    hono: Hono<AppEnv>,
    collectionPath: string,
    docPath: string,
    table: string,
    fields: readonly string[]
) {
    const options = { table, fields }

    // Collection ──────────────────────────────────────────────────────────────

    hono.get(collectionPath, livequery(), async c => {
        try {
            const req = c.get('livequery')
            const result = await ds.query(c.env.DB, req, options)
            // req.ref is the LivequeryRequestParser-normalised ref (e.g. 'tasks'),
            // which matches what RestTransporter passes to socket.listen().
            await subscribe(c, req.ref)
            return c.json(result)
        } catch (e) {
            return fail(c, e)
        }
    })

    hono.post(collectionPath, livequery(), async c => {
        try {
            const req = c.get('livequery')
            const result = await ds.add(c.env.DB, req, options)
            // req.ref for a collection POST equals req.collection_ref (e.g. 'tasks').
            broadcast(c, { ref: req.ref, type: 'added', data: result.item })
            return c.json(result, 201)
        } catch (e) {
            return fail(c, e)
        }
    })

    // Document ────────────────────────────────────────────────────────────────

    hono.get(docPath, livequery(), async c => {
        try {
            const req = c.get('livequery')
            const result = await ds.query(c.env.DB, req, options)
            await subscribe(c, req.ref)
            return c.json(result)
        } catch (e) {
            return fail(c, e)
        }
    })

    const write = (type: 'modified' | 'removed') => async (c: Context<AppEnv>) => {
        try {
            const req = c.get('livequery')
            const result = type === 'removed'
                ? await ds.delete(c.env.DB, req, options)
                : await ds.update(c.env.DB, req, options)
            // Broadcast on the COLLECTION ref — the gateway auto-fans-out to
            // 'collection_ref/id' subscribers via UpdatedData.data.id.
            broadcast(c, { ref: req.collection_ref ?? req.ref, type, data: result.item })
            return c.json(result)
        } catch (e) {
            return fail(c, e)
        }
    }

    hono.put(docPath, livequery(), write('modified'))
    hono.patch(docPath, livequery(), write('modified'))
    hono.delete(docPath, livequery(), write('removed'))
}

// ─── Register routes ────────────────────────────────────────────────────────

const TASK_FIELDS = ['title', 'status', 'created_at']

// All tasks (no status filter)
createRoutes(app, '/livequery/tasks', '/livequery/tasks/:id', 'tasks', TASK_FIELDS)

// Tasks filtered by status — the :status route key maps to WHERE status = ?
createRoutes(
    app,
    '/livequery/status/:status/tasks',
    '/livequery/status/:status/tasks/:id',
    'tasks',
    TASK_FIELDS
)

export default app
