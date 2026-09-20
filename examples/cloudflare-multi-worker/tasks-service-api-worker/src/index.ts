import { Hono } from 'hono'
import * as z from 'zod/mini'
import { resource } from '../../shared/resource.js'

const Task = z.strictObject({
    title: z.string().check(z.minLength(1)),
    status: z._default(z.enum(['todo', 'done']), 'todo'),
    assignee_id: z.optional(z.string()),
    created_at: z.optional(z.int()),
})

const app = new Hono<{ Bindings: TasksServiceEnv }>()

app.get('/health', c => c.json({ ok: true, worker: 'tasks-service-api-worker' }))
app.route('/', resource({ name: 'tasks', binding: 'TASKS_DB', schema: Task, patch: z.partial(Task) }))
app.notFound(c => c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404))

export default app
