/**
 * Sync routes against a real MongoDB. Skipped unless LIVEQUERY_E2E_MONGO_URL is set:
 *
 *   LIVEQUERY_E2E_MONGO_URL=mongodb://… bun test tests/sync.e2e.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { MongoClient } from 'mongodb'
import { MongoDatasource } from '../src/MongoDatasource.js'

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

        // A tombstone cannot be edited back to life.
        await run({ method: 'patch', is_collection: false, document_id: b.id, keys: { id: b.id }, body: { text: 'zombie' } })
        const raw = await client!.db(DB_NAME).collection(collection_name).countDocuments({ text: 'zombie' })
        expect(raw).toBe(0)
    })
})
