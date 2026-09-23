/**
 * Chat demo — API, realtime WebSocket and the built web app in one Bun process.
 *
 *   MONGO_URL='mongodb://user:pass@host:27017/?directConnection=true' bun examples/chat-demo/server.ts
 *
 * Collections: accounts, chats, messages. Realtime comes from MongoDB change streams:
 *   accounts                     → every account list
 *   accounts/:member_ids/chats   → the chat list of each member (fanned out over the array)
 *   chats                        → one chat's header (title, members, read receipts)
 *   chats/:chat_id/messages      → one chat's messages
 */
import { Hono, type Context, type Next } from 'hono'
import { serveStatic } from 'hono/bun'
import * as z from 'zod/mini'
import { MongoClient, UUID, type Collection } from 'mongodb'
import { uuidv7 } from 'uuidv7'
import { LIVEQUERY_REALTIME_PATH, resolveClientId, toLivequeryError } from '@livequery/core'
import { MongodbRealtime, fromMongoId, mongodb } from '@livequery/mongodb'
import { errorHandler, livequery, realtime, realtimeGateway, serve, validator } from '@livequery/honojs'
import { seed } from './seed.ts'

const PORT = Number(process.env.PORT ?? 8091)
const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017/?directConnection=true'
const DB_NAME = process.env.DB_NAME ?? 'livequery_chat_demo'
const STATIC_ROOT = process.env.STATIC_ROOT ?? './dist'
// Public demo: bounded so nobody can fill the disk.
const MAX = { accounts: 500, chats: 2000, messages: 50_000 }

// ── Schemas: validate writes, and list the fields a client may filter or sort on ─────────────

const Account = z.strictObject({ name: z.string(), created_at: z.number() })
const Chat = z.strictObject({
    title: z.optional(z.string()),
    type: z.string(),
    member_ids: z.array(z.string()),
    updated_at: z.number(),
    created_at: z.number(),
})
const Message = z.strictObject({
    text: z.string().check(z.minLength(1), z.maxLength(2000)),
    sender_id: z.string(),
    created_at: z.number(),
})

// ── Database ─────────────────────────────────────────────────────────────────────────────────

const client = await new MongoClient(MONGO_URL).connect()
const db = client.db(DB_NAME)
for (const name of ['accounts', 'chats', 'messages']) await db.createCollection(name).catch(() => undefined)
const accounts = db.collection<any>('accounts')
const chats = db.collection<any>('chats')
const messages = db.collection<any>('messages')
await accounts.createIndex({ name_key: 1 }, { unique: true })
await chats.createIndex({ member_ids: 1, updated_at: -1 })
await chats.createIndex({ member_key: 1 })
await messages.createIndex({ chat_id: 1, created_at: -1 })
await seed(db)

const gateway = await realtimeGateway()
new MongodbRealtime()
    .watch({ connections: { default: db } }, [
        { schema: 'accounts', options: { collection: 'accounts', realtime: true } },
        { schema: 'accounts/:member_ids/chats', options: { collection: 'chats', realtime: true } },
        { schema: 'chats', options: { collection: 'chats', realtime: true } },
        { schema: 'chats/:chat_id/messages', options: { collection: 'messages', realtime: true } },
    ])
    .subscribe({
        next: update => gateway.next(update),
        error: e => console.error(JSON.stringify({ event: 'change_stream_failed', message: String(e) })),
    })

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────

// Hono hands only real Errors to its error handler; anything else comes out as a bare 500.
const fail = (status: number, code: string, message: string) => toLivequeryError({ status, code, message })
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const idOf = (value: string) => {
    if (!UUID_PATTERN.test(value)) throw fail(400, 'INVALID_ID', `Not an id: ${JSON.stringify(value)}`)
    return new UUID(value)
}
const publicDoc = (doc: any) => {
    if (!doc) return doc
    const { _id, name_key: _key, member_key: _member_key, ...rest } = doc
    return { ...rest, id: fromMongoId(_id) }
}
const newId = (body: unknown) => resolveClientId(body) ?? uuidv7()
const cap = (collection: Collection<any>, max: number, what: string) => async (_c: Context, next: Next) => {
    if (await collection.estimatedDocumentCount() >= max) throw fail(400, 'DEMO_FULL', `The demo holds at most ${max} ${what}`)
    await next()
}
const colors = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#db2777', '#4d7c0f']

// ── App ──────────────────────────────────────────────────────────────────────────────────────

const app = new Hono()
app.onError(errorHandler())
app.get('/health', c => c.json({ ok: true, gateway_id: gateway.id }))
app.get(LIVEQUERY_REALTIME_PATH, c => c.text('Expected WebSocket', 426))

// Accounts. Joining is by name only (a demo): an existing name logs into that account.
app.get('/livequery/accounts', validator(Account), livequery(), mongodb({ connection: db, collection: 'accounts' }), realtime(gateway))
app.get('/livequery/accounts/:id', validator(Account), livequery(), mongodb({ connection: db, collection: 'accounts' }), realtime(gateway))
app.post('/livequery/accounts', cap(accounts, MAX.accounts, 'accounts'), async c => {
    const body = await c.req.json().catch(() => ({}))
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (name.length < 1 || name.length > 32) throw fail(400, 'INVALID_NAME', 'A name is 1 to 32 characters')
    const name_key = name.toLowerCase()
    const existing = await accounts.findOne({ name_key })
    if (existing) return c.json({ data: publicDoc(existing) })
    const doc = {
        _id: idOf(newId(body)),
        name,
        name_key,
        color: colors[Math.floor(Math.random() * colors.length)],
        created_at: Date.now(),
    }
    // Two tabs joining with the same new name at once: the unique index keeps one.
    await accounts.insertOne(doc).catch(e => { if (e?.code !== 11000) throw e })
    return c.json({ data: publicDoc(await accounts.findOne({ name_key })) }, 201)
})

// Chats. A direct chat between the same two people is reused, not duplicated.
app.get('/livequery/accounts/:member_ids/chats', validator(Chat), livequery(), mongodb({ connection: db, collection: 'chats' }), realtime(gateway))
app.get('/livequery/chats/:id', validator(Chat), livequery(), mongodb({ connection: db, collection: 'chats' }), realtime(gateway))
app.post('/livequery/chats', cap(chats, MAX.chats, 'chats'), async c => {
    const body = await c.req.json().catch(() => ({}))
    const member_ids = [...new Set<string>(Array.isArray(body?.member_ids) ? body.member_ids.filter((m: unknown) => typeof m === 'string') : [])]
    const title = typeof body?.title === 'string' ? body.title.trim().slice(0, 64) : ''
    if (member_ids.length < 2 || member_ids.length > 20) throw fail(400, 'INVALID_MEMBERS', 'A chat has 2 to 20 members')
    const known = await accounts.countDocuments({ _id: { $in: member_ids.map(idOf) } })
    if (known !== member_ids.length) throw fail(400, 'UNKNOWN_MEMBER', 'Every member must be an existing account')

    const type = member_ids.length === 2 && !title ? 'direct' : 'group'
    const member_key = type === 'direct' ? [...member_ids].sort().join(':') : undefined
    if (member_key) {
        const existing = await chats.findOne({ member_key })
        if (existing) return c.json({ data: publicDoc(existing) })
    }
    const now = Date.now()
    const doc = {
        _id: idOf(newId(body)),
        type,
        ...title ? { title } : {},
        member_ids,
        ...member_key ? { member_key } : {},
        read_at: Object.fromEntries(member_ids.map(m => [m, now])),
        unread: Object.fromEntries(member_ids.map(m => [m, 0])),
        updated_at: now,
        created_at: now,
    }
    await chats.insertOne(doc)
    return c.json({ data: publicDoc(doc) }, 201)
})

// Read receipt: the reader has seen everything up to now.
app.post('/livequery/chats/:id/~read', async c => {
    const body = await c.req.json().catch(() => ({}))
    const account_id = body?.account_id
    if (typeof account_id !== 'string') throw fail(400, 'INVALID_ACCOUNT', 'account_id is required')
    const _id = idOf(c.req.param('id') ?? '')
    const now = Date.now()
    // Only write when something changes, so an open chat does not spam change events.
    await chats.updateOne(
        { _id, member_ids: account_id, $or: [{ [`unread.${account_id}`]: { $gt: 0 } }, { [`read_at.${account_id}`]: { $lt: now - 1500 } }] },
        { $set: { [`read_at.${account_id}`]: now, [`unread.${account_id}`]: 0 } },
    )
    return c.json({ data: { ok: true } })
})

// Messages.
const sendGuard = async (c: Context, next: Next) => {
    const body = await c.req.raw.clone().json().catch(() => ({}))
    if (typeof body?.text === 'string' && body.text.trim().startsWith('/fail')) {
        throw fail(422, 'MESSAGE_REJECTED', 'The server refused this message (it starts with /fail)')
    }
    const chat = await chats.findOne({ _id: idOf(c.req.param('chat_id') ?? '') })
    if (!chat) throw fail(404, 'CHAT_NOT_FOUND', 'No such chat')
    if (!chat.member_ids.includes(body?.sender_id)) throw fail(403, 'NOT_A_MEMBER', 'The sender is not in this chat')
    c.set('chat' as never, chat as never)
    c.set('message' as never, body as never)
    await next()
}
// After the insert: the chat moves to the top of every member's list, with an unread count.
const afterSend = async (c: Context, next: Next) => {
    const chat = c.get('chat' as never) as any
    // Read by sendGuard: the request body cannot be read twice.
    const body = c.get('message' as never) as any
    if (c.res.status < 300 && chat && body) {
        const now = Date.now()
        const others = chat.member_ids.filter((m: string) => m !== body.sender_id)
        await chats.updateOne({ _id: chat._id }, {
            $set: {
                last_message: { text: String(body.text).slice(0, 200), sender_id: body.sender_id, created_at: body.created_at },
                updated_at: now,
                [`read_at.${body.sender_id}`]: now,
                [`unread.${body.sender_id}`]: 0,
            },
            $inc: Object.fromEntries(others.map((m: string) => [`unread.${m}`, 1])),
        })
    }
    await next()
}
const messageSource = mongodb({ connection: db, collection: 'messages' })
app.get('/livequery/chats/:chat_id/messages', validator(Message), livequery(), messageSource, realtime(gateway))
app.post('/livequery/chats/:chat_id/messages', cap(messages, MAX.messages, 'messages'), validator(Message), sendGuard, livequery(), messageSource, afterSend)

app.all('/livequery/*', c => c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404))

// The web app: assets, then index.html for every client-side route.
app.use('/assets/*', serveStatic({ root: STATIC_ROOT }))
app.get('/', c => c.redirect('/accounts'))
app.get('*', serveStatic({ path: `${STATIC_ROOT}/index.html` }))

console.log(JSON.stringify({ event: 'ready', port: PORT, db: DB_NAME }))
export default serve(app, { port: PORT, realtime: gateway })
