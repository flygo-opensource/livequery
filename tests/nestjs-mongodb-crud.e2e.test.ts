/**
 * E2E: HTTP contract of the NestJS adapter (LivequeryInterceptor + MongoDatasource)
 * over real MongoDB. The deep MongoQuery matrix is covered in hono-mongodb-crud;
 * this suite pins the NestJS-specific wiring: `{ data }` envelope, interceptor
 * parsing, private-field hiding, and the error contract.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ObjectId } from 'mongodb'
import { buildNestMongoApp, type AppHandle } from './helpers/servers.js'
import { uniqueCollection } from './helpers/mongo.js'
import { fetchJson } from './helpers/ws.js'

const COLLECTION = uniqueCollection('nest_crud')

describe('NestJS + MongoDatasource CRUD e2e', () => {
    let app: AppHandle
    let seedId: string

    beforeAll(async () => {
        app = await buildNestMongoApp({ collection: COLLECTION, ref: 'tasks', realtime: false })
        const seed = await app.collection.insertOne({ title: 'seed', done: false, _secret: 'hidden', seq: 1 })
        seedId = seed.insertedId.toString()
    }, 30000)

    afterAll(async () => {
        await app?.close()
    }, 30000)

    test('GET collection returns the { data } envelope with paging and hidden private fields', async () => {
        const { status, body } = await fetchJson(`${app.apiUrl}/tasks`)
        expect(status).toBe(200)
        expect(body.data).toBeDefined()
        expect(Array.isArray(body.data.items)).toBe(true)

        const seed = body.data.items.find((i: any) => i.title === 'seed')
        expect(seed.id).toBe(seedId)
        expect(seed._secret).toBeUndefined()
        expect(seed._id).toBeUndefined()
        expect(body.data.count.current).toBeGreaterThanOrEqual(1)
        expect(body.data.has).toBeDefined()
    })

    test('GET document returns item', async () => {
        const { status, body } = await fetchJson(`${app.apiUrl}/tasks/${seedId}`)
        expect(status).toBe(200)
        expect(body.data.item).toMatchObject({ id: seedId, title: 'seed' })
    })

    test('POST persists and returns the created item', async () => {
        const { status, body } = await fetchJson(`${app.apiUrl}/tasks`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'created', done: false, seq: 2 }),
        })
        expect(status).toBe(201) // NestJS default for POST
        expect(body.data.item.id).toBeString()

        const stored = await app.collection.findOne({ _id: ObjectId.createFromHexString(body.data.item.id) })
        expect(stored?.title).toBe('created')
    })

    test('PATCH applies $set semantics', async () => {
        const { status, body } = await fetchJson(`${app.apiUrl}/tasks/${seedId}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ done: true }),
        })
        expect(status).toBe(200)
        expect(body.data.item).toMatchObject({ id: seedId, done: true })

        const stored = await app.collection.findOne({ _id: ObjectId.createFromHexString(seedId) })
        expect(stored?.done).toBe(true)
        expect(stored?.title).toBe('seed')
    })

    test('DELETE removes the document', async () => {
        const insert = await app.collection.insertOne({ title: 'temp' })
        const id = insert.insertedId.toString()
        const { status } = await fetchJson(`${app.apiUrl}/tasks/${id}`, { method: 'DELETE' })
        expect(status).toBe(200)
        expect(await app.collection.findOne({ _id: insert.insertedId })).toBeNull()
    })

    test('filters and sort flow through the interceptor query parsing', async () => {
        await app.collection.insertMany([
            { title: 'f-1', seq: 10, done: false },
            { title: 'f-2', seq: 20, done: false },
        ])
        const { body } = await fetchJson(`${app.apiUrl}/tasks?seq:gte=10&seq:sort=desc`)
        const seqs = body.data.items.map((i: any) => i.seq)
        expect(seqs.length).toBeGreaterThanOrEqual(2)
        expect([...seqs].sort((x, y) => y - x)).toEqual(seqs)
        expect(seqs.every((s: number) => s >= 10)).toBe(true)
    })

    test('cursor paging works through the adapter', async () => {
        const bulk = Array.from({ length: 5 }, (_, i) => ({ title: `page-${i}`, seq: 100 + i, done: false }))
        await app.collection.insertMany(bulk)

        const page1 = await fetchJson(`${app.apiUrl}/tasks?:limit=3&seq:sort=asc`)
        expect(page1.body.data.items.length).toBe(3)
        const cursor = page1.body.data.cursor.last

        const page2 = await fetchJson(`${app.apiUrl}/tasks?:limit=3&seq:sort=asc&:after=${encodeURIComponent(cursor)}`)
        const ids1 = new Set(page1.body.data.items.map((i: any) => i.id))
        expect(page2.body.data.items.length).toBeGreaterThanOrEqual(1)
        for (const item of page2.body.data.items) expect(ids1.has(item.id)).toBe(false)
    })
})
