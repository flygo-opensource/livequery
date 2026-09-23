/**
 * Sync routes against a real MongoDB. Skipped unless LIVEQUERY_E2E_MONGO_URL is set:
 *
 *   LIVEQUERY_E2E_MONGO_URL=mongodb://… bun test tests/sync.e2e.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { MongoClient } from 'mongodb'
import { MongoDatasource } from '../src/MongoDatasource.js'
import { withVersion } from '../src/withVersion.js'

const URL = process.env.LIVEQUERY_E2E_MONGO_URL
const DB_NAME = process.env.LIVEQUERY_E2E_DB_NAME ?? 'livequery'
const client = URL ? new MongoClient(URL, { serverSelectionTimeoutMS: 15_000 }) : undefined
const collection_name = `sync_e2e_${Date.now()}`

// A uuidv7: 48-bit ms timestamp, version 7, variant 10, random rest.
const uuidv7 = () => {
    const hex = Date.now().toString(16).padStart(12, '0') + crypto.randomUUID().replace(/-/g, '').slice(12)
    const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

afterAll(async () => {
    if (!client) return
    await client.db(DB_NAME).collection(collection_name).drop().catch(() => undefined)
    await client.close()
})

const request = (overrides: Record<string, any>) => ({
    ref: 'messages', collection_ref: 'messages', schema_collection_ref: 'messages',
    is_collection: true, keys: {}, query: {}, method: 'get', ...overrides,
})

describe.skipIf(!URL)('sync route on a real MongoDB', () => {
    test('versions, tombstones and deltas', async () => {
        const datasource = new MongoDatasource({ connections: { default: client!.db(DB_NAME) } })
        const options = { collection: collection_name, sync: true }
        const run = (overrides: Record<string, any>) => datasource.query(request(overrides) as any, options) as Promise<any>

        const a = (await run({ method: 'post', body: { id: uuidv7(), text: 'a' } })).item
        const b = (await run({ method: 'post', body: { id: uuidv7(), text: 'b' } })).item
        expect(a.updated_at).toBeGreaterThan(0)
        const synced_at = Math.max(a.updated_at, b.updated_at)
        await new Promise(resolve => setTimeout(resolve, 5))

        const edited = (await run({ method: 'patch', is_collection: false, document_id: a.id, keys: { id: a.id }, body: { text: 'a!' } })).item
        expect(edited.updated_at).toBeGreaterThan(synced_at)
        await run({ method: 'delete', is_collection: false, document_id: b.id, keys: { id: b.id } })

        // Normal reads no longer see b, by list or by id.
        const list = await run({ query: { ':limit': 10 } })
        expect(list.items.map((d: any) => d.text)).toEqual(['a!'])
        const one = await run({ is_collection: false, document_id: b.id, keys: { id: b.id } })
        expect(one.item).toBeUndefined()

        // A delta since the first sync carries the edit and the tombstone.
        const delta = await run({ query: { 'updated_at:gt': synced_at, 'updated_at:sort': 'asc', ':limit': 10, ':tombstones': 1 } })
        expect(delta.items.map((d: any) => [d.id, d.text, d.deleted_at != null])).toEqual([
            [a.id, 'a!', false],
            [b.id, 'b', true],
        ])

        // Versions are the database's clock in ms; data is stored as sent, `$` strings included.
        const priced = (await run({ method: 'post', body: { id: uuidv7(), text: '$100', note: { at: '$now' } } })).item
        expect(Math.abs(priced.updated_at - Date.now())).toBeLessThan(60_000)
        const raw_priced = await client!.db(DB_NAME).collection(collection_name).findOne({ text: '$100' })
        expect(raw_priced).toMatchObject({ text: '$100', note: { at: '$now' }, updated_at: priced.updated_at })
        expect(raw_priced).not.toHaveProperty('__livequery_inserting')

        // The same id again: the insert fails as a duplicate, as before.
        const duplicate = await run({ method: 'post', body: { id: priced.id, text: 'again' } }).then(() => null, e => e)
        expect(duplicate).toMatchObject({ status: 409, code: 'ID_ALREADY_EXISTS' })

        // A tombstone cannot be edited back to life.
        await run({ method: 'patch', is_collection: false, document_id: b.id, keys: { id: b.id }, body: { text: 'zombie' } })
        const raw = await client!.db(DB_NAME).collection(collection_name).countDocuments({ text: 'zombie' })
        expect(raw).toBe(0)
    })

    test('the change stream sees an insert as an insert, and an edit or delete as an update', async () => {
        const datasource = new MongoDatasource({ connections: { default: client!.db(DB_NAME) } })
        const options = { collection: collection_name, sync: true }
        const run = (overrides: Record<string, any>) => datasource.query(request(overrides) as any, options) as Promise<any>
        const stream = client!.db(DB_NAME).collection(collection_name).watch([], { fullDocument: 'updateLookup' })
        const seen: string[] = []
        stream.on('change', change => seen.push(change.operationType))
        await new Promise(resolve => setTimeout(resolve, 1000))  // the stream opens asynchronously

        const doc = (await run({ method: 'post', body: { id: uuidv7(), text: 'watched' } })).item
        await run({ method: 'patch', is_collection: false, document_id: doc.id, keys: { id: doc.id }, body: { text: 'edited' } })
        await run({ method: 'delete', is_collection: false, document_id: doc.id, keys: { id: doc.id } })
        const started = Date.now()
        while (seen.length < 3 && Date.now() - started < 10_000) await new Promise(resolve => setTimeout(resolve, 100))
        await stream.close()
        expect(seen).toEqual(['insert', 'update', 'update'])
    })

    test('versions follow commit order: a slow write never ends up below one that committed first', async () => {
        const db = client!.db(DB_NAME)
        const coll = db.collection(collection_name)
        const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
        let a_version = 0
        const slow = withVersion(db, collection_name, async (version, session) => {
            a_version = version
            await sleep(1500)  // allocated, not committed yet
            await coll.insertOne({ text: 'slow', updated_at: version }, { session })
        })
        await sleep(200)
        const fast = withVersion(db, collection_name, (version, session) =>
            coll.insertOne({ text: 'fast', updated_at: version }, { session }).then(() => version))
        // While the slow one is open, the fast one cannot commit: a reader sees neither.
        await sleep(600)
        expect(await coll.countDocuments({ text: { $in: ['slow', 'fast'] } })).toBe(0)
        const [, fast_version] = await Promise.all([slow, fast])
        expect(fast_version).toBeGreaterThan(a_version)
        const stored = await coll.find({ text: { $in: ['slow', 'fast'] } }).sort({ updated_at: 1 }).toArray()
        expect(stored.map(d => d.text)).toEqual(['slow', 'fast'])
    })

    test('If-Match on a real database: the stale write is refused, the fresh one lands', async () => {
        const datasource = new MongoDatasource({ connections: { default: client!.db(DB_NAME) } })
        const options = { collection: collection_name, sync: true }
        const run = (overrides: Record<string, any>) => datasource.query(request(overrides) as any, options) as Promise<any>
        const doc = (await run({ method: 'post', body: { id: uuidv7(), text: 'v1' } })).item
        const b = (await run({ method: 'patch', is_collection: false, document_id: doc.id, keys: { id: doc.id }, body: { text: 'from B' }, if_version: doc.updated_at })).item
        expect(b.updated_at).toBeGreaterThan(doc.updated_at)
        const stale = await run({ method: 'patch', is_collection: false, document_id: doc.id, keys: { id: doc.id }, body: { text: 'from A' }, if_version: doc.updated_at }).then(() => null, e => e)
        expect(stale).toMatchObject({ status: 409, code: 'VERSION_CONFLICT' })
        const fresh = (await run({ method: 'patch', is_collection: false, document_id: doc.id, keys: { id: doc.id }, body: { text: 'from A' }, if_version: b.updated_at })).item
        expect(fresh.updated_at).toBeGreaterThan(b.updated_at)
        const raw = await client!.db(DB_NAME).collection(collection_name).findOne({ updated_at: fresh.updated_at })
        expect(raw?.text).toBe('from A')
    })
})
