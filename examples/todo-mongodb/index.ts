/**
 * Todo app on MongoDB — the same file on Node and on Bun.
 *
 *   node examples/todo-mongodb/index.ts
 *   bun  examples/todo-mongodb/index.ts
 *
 * One process holds both the API and the client WebSockets, so there is no gateway here: the
 * `realtime()` middleware talks to the in-process gateway directly.
 *
 * Changes do not come from the write path. `MongodbRealtime.watch()` follows the collection's
 * change stream and pushes into the same gateway, so a write from mongosh, a cron job or
 * another service reaches subscribed clients exactly like a write through this API.
 */
import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import * as z from 'zod/mini'
import { MongoClient } from 'mongodb'
import { LIVEQUERY_REALTIME_PATH } from '@livequery/core'
import { MongodbRealtime, mongodb } from '@livequery/mongodb'
import { errorHandler, livequery, realtime, realtimeGateway, serve, validator } from '@livequery/honojs'
import { COLLECTION, DB_NAME, MONGO_URL, PORT } from './config.ts'

// The schema validates writes and is the allowlist of fields a client may filter or sort on.
const Todo = z.strictObject({
    title: z.string().check(z.minLength(1)),
    done: z._default(z.boolean(), false),
})
const TodoPatch = z.partial(Todo)

const client = await new MongoClient(MONGO_URL).connect()
const db = client.db(DB_NAME)

// A change stream needs the collection to exist, and so does the collMod that turns on
// pre/post images — so the `removed` event can carry the document that was deleted.
await db.createCollection(COLLECTION).catch(() => undefined)

const gateway = await realtimeGateway()
const source = mongodb({ connection: db, collection: COLLECTION })
const check = validator(Todo, { patch: TodoPatch })

// `schema` is the route path with its document-id segment stripped — the ref clients subscribe to.
const changes = new MongodbRealtime().watch(
    { connections: { default: db } },
    [{ schema: 'todos', options: { collection: COLLECTION, realtime: true } }],
)
changes.subscribe({
    next: update => gateway.next(update),
    error: e => console.error(JSON.stringify({ event: 'change_stream_failed', message: String(e) })),
})

const page = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8')

const app = new Hono()
app.onError(errorHandler())

app.use('/livequery/*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'x-lcid', 'x-lgid'],
}))

app.get('/', c => c.html(page))
app.get('/health', c => c.json({ ok: true, kind: 'todo-mongodb', gateway_id: gateway.id }))
app.get(LIVEQUERY_REALTIME_PATH, c => c.text('Expected WebSocket', 426))

// Reads subscribe the caller; writes stay plain, because the change stream publishes them.
app.get('/livequery/todos', check, livequery(), source, realtime(gateway))
app.get('/livequery/todos/:id', check, livequery(), source, realtime(gateway))
app.post('/livequery/todos', check, livequery(), source)
app.put('/livequery/todos/:id', check, livequery(), source)
app.patch('/livequery/todos/:id', check, livequery(), source)
app.delete('/livequery/todos/:id', livequery(), source)

app.notFound(c => c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404))

console.log(JSON.stringify({ event: 'ready', kind: 'todo-mongodb', port: PORT, collection: COLLECTION }))
export default serve(app, { port: PORT, realtime: gateway })
