/**
 * Tasks service API — the same file on Node and on Bun.
 *
 *   node examples/api-gateway/service.ts
 *   bun  examples/api-gateway/service.ts
 *
 * `serve()` comes from whichever build of @livequery/honojs the runtime resolved, so nothing here
 * tests for a runtime. `realtime()` takes no argument: this service sits behind the gateway and
 * only annotates its responses, and the gateway does the subscribing and publishing.
 */
import { Hono } from 'hono'
import * as z from 'zod/mini'
import { errorHandler, livequery, realtime, serve, validator } from '@livequery/honojs'
import { announceService } from '@livequery/discovery'
import { DISCOVERY, SERVICE_PORT } from './shared/config.ts'
import { memory } from './shared/memory.ts'
import { TaskStore } from './shared/TaskStore.ts'

const Task = z.strictObject({
    title: z.string().check(z.minLength(1)),
    status: z._default(z.enum(['todo', 'done']), 'todo'),
})
const TaskPatch = z.partial(Task)

const store = new TaskStore()
const source = memory(store)
const check = validator(Task, { patch: TaskPatch })

const app = new Hono()
app.onError(errorHandler())

app.get('/health', c => c.json({ ok: true, kind: 'service' }))
app.get('/livequery/tasks', check, livequery(), source, realtime())
app.post('/livequery/tasks', check, livequery(), source, realtime())
app.get('/livequery/tasks/:id', check, livequery(), source, realtime())
app.put('/livequery/tasks/:id', check, livequery(), source, realtime())
app.patch('/livequery/tasks/:id', check, livequery(), source, realtime())
app.delete('/livequery/tasks/:id', livequery(), source, realtime())

if (DISCOVERY) {
    // Tell gateways it is here and which prefixes it owns (its /livequery routes), once. Gateways
    // then keep a connection to it: when this process ends — even killed — they drop it.
    const announced = await announceService({ name: 'tasks', port: SERVICE_PORT, app })
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.once(signal, () => void announced.close().finally(() => process.exit(0)))
    }
}

console.log(JSON.stringify({ event: 'ready', kind: 'service', port: SERVICE_PORT }))
export default serve(app, { port: SERVICE_PORT })
