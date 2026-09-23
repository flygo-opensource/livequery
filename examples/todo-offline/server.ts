/**
 * Offline-first todo demo — API, realtime WebSocket and the built web app in one Bun process.
 *
 *   MONGO_URL='mongodb://user:pass@host:27017/?directConnection=true' bun examples/todo-offline/server.ts
 *
 * Writes are plain; realtime comes from MongoDB's change stream, so every open tab and device sees
 * every change, whoever made it. The web app (web/) talks to this server with @livequery/client in
 * local-first mode: IndexedDB storage, a durable outbox, client-chosen ids.
 */
import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import * as z from 'zod/mini'
import { MongoClient } from 'mongodb'
import { LIVEQUERY_REALTIME_PATH } from '@livequery/core'
import { MongodbRealtime, mongodb } from '@livequery/mongodb'
import { errorHandler, livequery, realtime, realtimeGateway, serve, validator } from '@livequery/honojs'

const PORT = Number(process.env.PORT ?? 8090)
const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017/?directConnection=true'
const DB_NAME = process.env.DB_NAME ?? 'livequery_demo'
const COLLECTION = process.env.COLLECTION ?? 'todos'
const STATIC_ROOT = process.env.STATIC_ROOT ?? './dist'
// A public demo: keep the collection small enough that nobody can fill the disk.
const MAX_TODOS = Number(process.env.MAX_TODOS ?? 500)

const Todo = z.strictObject({
    title: z.string().check(z.minLength(1), z.maxLength(200)),
    done: z._default(z.boolean(), false),
    created_at: z.number(),
})
const TodoPatch = z.partial(Todo)

const client = await new MongoClient(MONGO_URL).connect()
const db = client.db(DB_NAME)
await db.createCollection(COLLECTION).catch(() => undefined)
const todos = db.collection(COLLECTION)

const gateway = await realtimeGateway()
const source = mongodb({ connection: db, collection: COLLECTION })
const check = validator(Todo, { patch: TodoPatch })

new MongodbRealtime()
    .watch({ connections: { default: db } }, [{ schema: 'todos', options: { collection: COLLECTION, realtime: true } }])
    .subscribe({
        next: update => gateway.next(update),
        error: e => console.error(JSON.stringify({ event: 'change_stream_failed', message: String(e) })),
    })

const app = new Hono()
app.onError(errorHandler())

app.get('/health', c => c.json({ ok: true, gateway_id: gateway.id }))
app.get(LIVEQUERY_REALTIME_PATH, c => c.text('Expected WebSocket', 426))

const limit = async (c: any, next: () => Promise<void>) => {
    if (await todos.estimatedDocumentCount() >= MAX_TODOS) {
        return c.json({ error: { code: 'DEMO_FULL', message: `The demo holds at most ${MAX_TODOS} todos` } }, 400)
    }
    await next()
}

app.get('/livequery/todos', check, livequery(), source, realtime(gateway))
app.get('/livequery/todos/:id', check, livequery(), source, realtime(gateway))
app.post('/livequery/todos', limit, check, livequery(), source)
app.patch('/livequery/todos/:id', check, livequery(), source)
app.delete('/livequery/todos/:id', livequery(), source)
app.all('/livequery/*', c => c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404))

app.use('/*', serveStatic({ root: STATIC_ROOT }))
app.get('*', serveStatic({ path: `${STATIC_ROOT}/index.html` }))

console.log(JSON.stringify({ event: 'ready', port: PORT, db: DB_NAME, collection: COLLECTION }))
export default serve(app, { port: PORT, realtime: gateway })
