import { Hono } from 'hono'
import { handleD1ServiceRequest } from '../../shared/d1-service.js'
import type { D1ServiceDefinition } from '../../shared/d1-service.js'

const definition: D1ServiceDefinition = {
    collectionPath: '/livequery/incidents',
    documentPath: '/livequery/incidents/:id',
    table: 'incidents',
    queryFields: ['elevator_id', 'title', 'severity', 'status', 'created_at'],
    writeFields: ['elevator_id', 'title', 'severity', 'status'],
    requiredCreateFields: ['elevator_id', 'title'],
}

const app = new Hono<{ Bindings: IncidentsServiceEnv }>()

app.get('/health', c => c.json({ ok: true, worker: 'incidents-service-api-worker' }))

app.on(['GET', 'POST'], definition.collectionPath, c => handleD1ServiceRequest({
    request: c.req.raw,
    routePath: c.req.routePath,
    params: c.req.param(),
    query: c.req.query(),
    database: c.env.INCIDENTS_DB,
    definition,
}))

app.on(['GET', 'PUT', 'PATCH', 'DELETE'], definition.documentPath, c => handleD1ServiceRequest({
    request: c.req.raw,
    routePath: c.req.routePath,
    params: c.req.param(),
    query: c.req.query(),
    database: c.env.INCIDENTS_DB,
    definition,
}))

app.notFound(c => c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404))

export default app
