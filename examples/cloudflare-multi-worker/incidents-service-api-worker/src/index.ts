import { Hono } from 'hono'
import * as z from 'zod/mini'
import { resource } from '../../shared/resource.js'

const Incident = z.strictObject({
    elevator_id: z.string().check(z.minLength(1)),
    title: z.string().check(z.minLength(1)),
    severity: z._default(z.enum(['info', 'warning', 'critical']), 'warning'),
    status: z._default(z.enum(['open', 'closed']), 'open'),
    created_at: z.optional(z.int()),
})

const app = new Hono<{ Bindings: IncidentsServiceEnv }>()

app.get('/health', c => c.json({ ok: true, worker: 'incidents-service-api-worker' }))
app.route('/', resource({ name: 'incidents', binding: 'INCIDENTS_DB', schema: Incident, patch: z.partial(Incident) }))
app.notFound(c => c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404))

export default app
