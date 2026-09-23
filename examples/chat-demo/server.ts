/**
 * Chat demo — API, realtime WebSocket and the built web app in one Bun process.
 *
 *   MONGO_URL='mongodb://user:pass@host:27017/?directConnection=true' bun examples/chat-demo/server.ts
 *
 * Collections: accounts, chats, messages. Realtime comes from MongoDB change streams:
 *   accounts                     → every account list
 *   accounts/:member_ids/chats   → the chat list of each member, and each chat in it (fanned out
 *                                  over the array)
 *   chats/:chat_id/messages      → one chat's messages
 *
 * Every route serves local-first sync: each write gets the collection's next version in
 * `updated_at` (in commit order, see `withVersion`), so a device that was offline asks only for
 * what changed since and misses nothing (see `sync: true` in @livequery/mongodb). The hand-written
 * routes below use `withVersion` too. Chats are ordered by
 * `active_at` (last message), not `updated_at`, so a read receipt does not reorder the list.
 */
import { Hono, type Context, type Next } from 'hono'
import { serveStatic } from 'hono/bun'
import * as z from 'zod/mini'
import { MongoClient, UUID, type Collection } from 'mongodb'
import { uuidv7 } from 'uuidv7'
import { LIVEQUERY_REALTIME_PATH, resolveClientId, toLivequeryError } from '@livequery/core'
import { MongodbRealtime, fromMongoId, mongodb, withVersion } from '@livequery/mongodb'
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
    active_at: z.number(),
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
await chats.createIndex({ member_ids: 1, active_at: -1 })
await chats.createIndex({ member_ids: 1, updated_at: 1 })
await chats.createIndex({ member_key: 1 })
await messages.createIndex({ chat_id: 1, created_at: -1 })
await messages.createIndex({ chat_id: 1, updated_at: 1 })
await accounts.createIndex({ updated_at: 1 })
await seed(db)
// Data written before sync existed: give it a version (and chats their list order).
await chats.updateMany({ active_at: { $exists: false } }, [{ $set: { active_at: '$updated_at' } }])
await messages.updateMany({ updated_at: { $exists: false } }, [{ $set: { updated_at: '$created_at' } }])
await accounts.updateMany({ updated_at: { $exists: false } }, [{ $set: { updated_at: '$created_at' } }])

const gateway = await realtimeGateway()
new MongodbRealtime()
    .watch({ connections: { default: db } }, [
        { schema: 'accounts', options: { collection: 'accounts', realtime: true } },
        { schema: 'accounts/:member_ids/chats', options: { collection: 'chats', realtime: true } },
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
const sync = true
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

// Accounts. Joining is by name only (a demo): the app signs into an existing name from its synced
// account list, so a POST is always a new name — a taken one is a conflict, not a login.
app.get('/livequery/accounts', validator(Account), livequery(), mongodb({ connection: db, collection: 'accounts', sync }), realtime(gateway))
app.get('/livequery/accounts/:id', validator(Account), livequery(), mongodb({ connection: db, collection: 'accounts', sync }), realtime(gateway))
app.post('/livequery/accounts', cap(accounts, MAX.accounts, 'accounts'), async c => {
    const body = await c.req.json().catch(() => ({}))
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (name.length < 1 || name.length > 32) throw fail(400, 'INVALID_NAME', 'A name is 1 to 32 characters')
    const doc = await withVersion(db, 'accounts', async (version, session) => {
        const doc = {
            _id: idOf(newId(body)),
            name,
            name_key: name.toLowerCase(),
            color: colors[Math.floor(Math.random() * colors.length)],
            created_at: Date.now(),
            updated_at: version,
        }
        await accounts.insertOne(doc, { session })
        return doc
    }).catch(e => {
        if (e?.code !== 11000) throw e
        if (e?.keyPattern?._id) throw fail(409, 'ID_ALREADY_EXISTS', 'This account was already created')
        throw fail(409, 'NAME_TAKEN', `"${name}" is taken — pick it from the list to sign in`)
    })
    return c.json({ data: publicDoc(doc) }, 201)
})

// Chats, always seen through a member: /accounts/:me/chats lists mine, /accounts/:me/chats/:id is
// one of them. A new chat takes the id the device chose, so it can be created (and written to) offline.
app.get('/livequery/accounts/:member_ids/chats', validator(Chat), livequery(), mongodb({ connection: db, collection: 'chats', sync }), realtime(gateway))
app.get('/livequery/accounts/:member_ids/chats/:id', validator(Chat), livequery(), mongodb({ connection: db, collection: 'chats', sync }), realtime(gateway))
app.post('/livequery/accounts/:account_id/chats', cap(chats, MAX.chats, 'chats'), async c => {
    const body = await c.req.json().catch(() => ({}))
    const account_id = c.req.param('account_id') ?? ''
    const member_ids = [...new Set<string>([account_id, ...Array.isArray(body?.member_ids) ? body.member_ids.filter((m: unknown) => typeof m === 'string') : []])]
    const title = typeof body?.title === 'string' ? body.title.trim().slice(0, 64) : ''
    if (member_ids.length < 2 || member_ids.length > 20) throw fail(400, 'INVALID_MEMBERS', 'A chat has 2 to 20 members')
    const known = await accounts.countDocuments({ _id: { $in: member_ids.map(idOf) } })
    if (known !== member_ids.length) throw fail(400, 'UNKNOWN_MEMBER', 'Every member must be an existing account')

    const type = member_ids.length === 2 && !title ? 'direct' : 'group'
    const member_key = type === 'direct' ? [...member_ids].sort().join(':') : undefined
    const now = Date.now()
    const fields = {
        _id: idOf(newId(body)),
        type,
        ...title ? { title } : {},
        member_ids,
        ...member_key ? { member_key } : {},
        read_at: Object.fromEntries(member_ids.map(m => [m, now])),
        unread: Object.fromEntries(member_ids.map(m => [m, 0])),
        active_at: now,
        created_at: now,
    }
    // A direct chat between two people exists once: the app opens the existing one from its synced
    // list; two devices creating it at the same moment get this answer.
    if (member_key && await chats.findOne({ member_key })) throw fail(409, 'CHAT_EXISTS', 'You already have a chat with this person')
    const doc = await withVersion(db, 'chats', async (version, session) => {
        const doc = { ...fields, updated_at: version }
        await chats.insertOne(doc, { session })
        return doc
    }).catch(e => {
        if (e?.code === 11000 && e?.keyPattern?._id) throw fail(409, 'ID_ALREADY_EXISTS', 'This chat was already created')
        throw e
    })
    return c.json({ data: publicDoc(doc) }, 201)
})

// Read receipt: the reader has seen everything up to now.
app.post('/livequery/accounts/:account_id/chats/:id/~read', async c => {
    const account_id = c.req.param('account_id') ?? ''
    const _id = idOf(c.req.param('id') ?? '')
    const now = Date.now()
    // Only write when something changes, so an open chat does not spam change events.
    const filter = { _id, member_ids: account_id, $or: [{ [`unread.${account_id}`]: { $gt: 0 } }, { [`read_at.${account_id}`]: { $lt: now - 1500 } }] }
    if (await chats.countDocuments(filter, { limit: 1 }) > 0) {
        await withVersion(db, 'chats', (version, session) => chats.updateOne(
            filter,
            { $set: { [`read_at.${account_id}`]: now, [`unread.${account_id}`]: 0, updated_at: version } },
            { session },
        ))
    }
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
        await withVersion(db, 'chats', (version, session) => chats.updateOne({ _id: chat._id }, {
            $set: {
                last_message: { text: String(body.text).slice(0, 200), sender_id: body.sender_id, created_at: body.created_at },
                active_at: now,
                updated_at: version,
                [`read_at.${body.sender_id}`]: now,
                [`unread.${body.sender_id}`]: 0,
            },
            $inc: Object.fromEntries(others.map((m: string) => [`unread.${m}`, 1])),
        }, { session }))
    }
    await next()
}
const messageSource = mongodb({ connection: db, collection: 'messages', sync })
app.get('/livequery/chats/:chat_id/messages', validator(Message), livequery(), messageSource, realtime(gateway))
app.post('/livequery/chats/:chat_id/messages', cap(messages, MAX.messages, 'messages'), validator(Message), sendGuard, livequery(), messageSource, afterSend)

app.all('/livequery/*', c => c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404))

// The web app: assets, the PWA files, then index.html for every client-side route.
app.use('/assets/*', serveStatic({ root: STATIC_ROOT }))
// The service worker must never be cached by HTTP, or a new version would wait for the cache to expire.
app.get('/sw.js', serveStatic({ path: `${STATIC_ROOT}/sw.js`, onFound: (_path, c) => { c.header('cache-control', 'no-cache') } }))
app.get('/manifest.webmanifest', serveStatic({ path: `${STATIC_ROOT}/manifest.webmanifest`, mimes: { webmanifest: 'application/manifest+json' } }))
app.get('/icon.svg', serveStatic({ path: `${STATIC_ROOT}/icon.svg` }))
app.get('/', c => c.redirect('/accounts'))
app.get('*', serveStatic({ path: `${STATIC_ROOT}/index.html` }))

console.log(JSON.stringify({ event: 'ready', port: PORT, db: DB_NAME }))
export default serve(app, { port: PORT, realtime: gateway })
