import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { D1Datasource } from '@livequery/d1'
import { livequery } from './middleware.js'
import { getLivequeryRequest } from './request.js'
import { broadcast, subscribe } from './broadcast.js'
import type { Env } from './types.js'

// The Durable Object class must be a named export of the Worker module.
export { RealtimeGatewayDO } from './RealtimeGatewayDO.js'

// ─── App ────────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>()
const ds = new D1Datasource()

app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] }))

// ─── Error handler ──────────────────────────────────────────────────────────

function apiError(e: unknown): { status: number; body: { error: { code: string; message: string } } } {
    const err = e as { status?: number; code?: string; message?: string }
    return {
        status: typeof err.status === 'number' ? err.status : 500,
        body: { error: { code: err.code ?? 'INTERNAL', message: err.message ?? 'Internal error' } },
    }
}

// ─── WebSocket → Durable Object ─────────────────────────────────────────────

app.get('/livequery/realtime-updates', c => {
    const id = c.env.GATEWAY.idFromName('main')
    const stub = c.env.GATEWAY.get(id)
    const wsUrl = new URL(c.req.url)
    wsUrl.pathname = '/ws'
    return stub.fetch(new Request(wsUrl.toString(), c.req.raw))
})

// ─── Route factory ──────────────────────────────────────────────────────────
//
// Creates all 5 HTTP verbs for a (collection, document) pair backed by one table.
// Realtime subscriptions are driven by the client's WS protocol — the client
// sends { event: "subscribe", ref } through the WebSocket after each successful
// GET that it wants to watch.

export function createRoutes(
    hono: Hono<{ Bindings: Env }>,
    collectionPath: string,
    docPath: string,
    table: string
) {
    // Collection ──────────────────────────────────────────────────────────────

    hono.get(collectionPath, livequery(), async c => {
        try {
            const req = getLivequeryRequest(c)!
            const result = await ds.query(c.env.DB, req, { table })
            const clientId = c.req.header('x-lcid')
            const gatewayId = c.req.header('x-lgid')
            if (clientId && gatewayId) {
                // req.ref is the LivequeryRequestParser-normalised ref (e.g. 'tasks'),
                // which matches what RestTransporter passes to socket.listen().
                subscribe(c.env.GATEWAY, { ref: req.ref, client_id: clientId, gateway_id: gatewayId, listener_node_id: gatewayId }).catch(() => {})
            }
            return c.json(result)
        } catch (e) {
            const { status, body } = apiError(e)
            return c.json(body, status as never)
        }
    })

    hono.post(collectionPath, livequery(), async c => {
        try {
            const req = getLivequeryRequest(c)!
            const result = await ds.add(c.env.DB, req, { table })
            const item = result.item as { id: string }
            // req.ref for a collection POST equals req.collection_ref (e.g. 'tasks').
            await broadcast(c.env.GATEWAY, { ref: req.ref, type: 'added', data: item })
            return c.json(result, 201)
        } catch (e) {
            const { status, body } = apiError(e)
            return c.json(body, status as never)
        }
    })

    // Document ────────────────────────────────────────────────────────────────

    hono.get(docPath, livequery(), async c => {
        try {
            const req = getLivequeryRequest(c)!
            const result = await ds.query(c.env.DB, req, { table })
            const clientId = c.req.header('x-lcid')
            const gatewayId = c.req.header('x-lgid')
            if (clientId && gatewayId) {
                subscribe(c.env.GATEWAY, { ref: req.ref, client_id: clientId, gateway_id: gatewayId, listener_node_id: gatewayId }).catch(() => {})
            }
            return c.json(result)
        } catch (e) {
            const { status, body } = apiError(e)
            return c.json(body, status as never)
        }
    })

    hono.put(docPath, livequery(), async c => {
        try {
            const req = getLivequeryRequest(c)!
            const result = await ds.update(c.env.DB, req, { table })
            const item = result.item as { id: string }
            // Broadcast on the COLLECTION ref — the gateway auto-fans-out to
            // 'collection_ref/id' subscribers via UpdatedData.data.id.
            await broadcast(c.env.GATEWAY, { ref: req.collection_ref, type: 'modified', data: item })
            return c.json(result)
        } catch (e) {
            const { status, body } = apiError(e)
            return c.json(body, status as never)
        }
    })

    hono.patch(docPath, livequery(), async c => {
        try {
            const req = getLivequeryRequest(c)!
            const result = await ds.update(c.env.DB, req, { table })
            const item = result.item as { id: string }
            await broadcast(c.env.GATEWAY, { ref: req.collection_ref, type: 'modified', data: item })
            return c.json(result)
        } catch (e) {
            const { status, body } = apiError(e)
            return c.json(body, status as never)
        }
    })

    hono.delete(docPath, livequery(), async c => {
        try {
            const req = getLivequeryRequest(c)!
            const result = await ds.delete(c.env.DB, req, { table })
            const item = result.item as { id: string }
            await broadcast(c.env.GATEWAY, { ref: req.collection_ref, type: 'removed', data: item })
            return c.json(result)
        } catch (e) {
            const { status, body } = apiError(e)
            return c.json(body, status as never)
        }
    })
}

// ─── Register routes ────────────────────────────────────────────────────────

// All tasks (no status filter)
createRoutes(app, '/livequery/tasks', '/livequery/tasks/:id', 'tasks')

// Tasks filtered by status — D1Query maps key "status" → WHERE status = ?
createRoutes(
    app,
    '/livequery/status/:status/tasks',
    '/livequery/status/:status/tasks/:id',
    'tasks'
)

export default app
