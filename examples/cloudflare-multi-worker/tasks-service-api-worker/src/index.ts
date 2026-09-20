import { Hono } from 'hono'
import { handleD1ServiceRequest } from '../../shared/d1-service.js'
import type { D1ServiceDefinition } from '../../shared/d1-service.js'

const definition: D1ServiceDefinition = {
    collectionPath: '/livequery/tasks',
    documentPath: '/livequery/tasks/:id',
    table: 'tasks',
    queryFields: ['title', 'status', 'assignee_id', 'created_at'],
    writeFields: ['title', 'status', 'assignee_id'],
    requiredCreateFields: ['title'],
}

const app = new Hono<{ Bindings: TasksServiceEnv }>()

app.get('/health', c => c.json({ ok: true, worker: 'tasks-service-api-worker' }))

app.on(['GET', 'POST'], definition.collectionPath, c => handleD1ServiceRequest({
    request: c.req.raw,
    routePath: c.req.routePath,
    params: c.req.param(),
    query: c.req.query(),
    database: c.env.TASKS_DB,
    definition,
}))

app.on(['GET', 'PUT', 'PATCH', 'DELETE'], definition.documentPath, c => handleD1ServiceRequest({
    request: c.req.raw,
    routePath: c.req.routePath,
    params: c.req.param(),
    query: c.req.query(),
    database: c.env.TASKS_DB,
    definition,
}))

app.notFound(c => c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404))

export default app
