/**
 * E2E: HTTP client → Hono (createLivequery + createDatasourceMapper/useDatasource)
 *      → MongoDatasource → real MongoDB.
 *
 * Covers the full CRUD + query matrix over the Hono adapter, asserting
 * useDatasource's native response shape (no `{ data }` envelope).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ObjectId } from '../mongodb/node_modules/mongodb/lib/index.js'
import { buildHonoMongoApp, type AppHandle } from './helpers/servers.js'
import { uniqueCollection } from './helpers/mongo.js'
import { fetchJson } from './helpers/ws.js'

const COLLECTION = uniqueCollection('hono_crud')

describe('Hono + MongoDatasource CRUD e2e', () => {
    let app: AppHandle
    let seedIds: string[] = []

    beforeAll(async () => {
        app = await buildHonoMongoApp({
            collection: COLLECTION,
            ref: 'products',
            realtime: false,
            wrapData: false,
        })

        const seed = await app.collection.insertMany([
            { name: 'phone', price: 100, status: 'active', _secret: 'hide-me' },
            { name: 'laptop', price: 900, status: 'active' },
            { name: 'mouse', price: 20, status: 'inactive' },
            { name: 'monitor', price: 300, status: 'active' },
        ])
        seedIds = Object.values(seed.insertedIds).map(id => id.toString())
    }, 30000)

    afterAll(async () => {
        await app?.close()
    }, 30000)

    test('GET collection returns items with paging and hides private fields', async () => {
        const { status, body } = await fetchJson(`${app.apiUrl}/products?:limit=10`)
        expect(status).toBe(200)
        expect(Array.isArray(body.items)).toBe(true)
        expect(body.items.length).toBe(4)
        expect(body.count).toMatchObject({ current: 4, total: 4 })
        expect(body.has).toMatchObject({ prev: false, next: false })

        const phone = body.items.find((item: any) => item.name === 'phone')
        expect(phone.id).toBe(seedIds[0])
        expect(phone._secret).toBeUndefined()
        expect(phone._id).toBeUndefined()
    })

    test('GET document by id returns item', async () => {
        const { status, body } = await fetchJson(`${app.apiUrl}/products/${seedIds[1]}`)
        expect(status).toBe(200)
        expect(body.item).toMatchObject({ id: seedIds[1], name: 'laptop', price: 900 })
    })

    test('POST creates a document persisted in mongo', async () => {
        const { status, body } = await fetchJson(`${app.apiUrl}/products`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'keyboard', price: 50, status: 'active' }),
        })
        expect(status).toBe(200)
        expect(body.item.id).toBeString()
        expect(body.item.name).toBe('keyboard')

        const stored = await app.collection.findOne({ _id: ObjectId.createFromHexString(body.item.id) })
        expect(stored?.name).toBe('keyboard')
        expect(stored?.price).toBe(50)
    })

    test('PATCH updates fields via $set semantics', async () => {
        const { status, body } = await fetchJson(`${app.apiUrl}/products/${seedIds[2]}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ price: 25 }),
        })
        expect(status).toBe(200)
        expect(body.item).toMatchObject({ id: seedIds[2], price: 25 })

        const stored = await app.collection.findOne({ _id: ObjectId.createFromHexString(seedIds[2]) })
        expect(stored?.price).toBe(25)
        expect(stored?.name).toBe('mouse') // untouched field preserved ($set, not replace)
    })

    test('DELETE removes the document from mongo', async () => {
        const insert = await app.collection.insertOne({ name: 'temp', price: 1 })
        const id = insert.insertedId.toString()

        const { status } = await fetchJson(`${app.apiUrl}/products/${id}`, { method: 'DELETE' })
        expect(status).toBe(200)

        const stored = await app.collection.findOne({ _id: insert.insertedId })
        expect(stored).toBeNull()
    })

    test('filters: gte + like + in', async () => {
        const gte = await fetchJson(`${app.apiUrl}/products?price:gte=300`)
        expect(gte.body.items.map((i: any) => i.name).sort()).toEqual(['laptop', 'monitor'])

        const like = await fetchJson(`${app.apiUrl}/products?name:like=pho`)
        expect(like.body.items.map((i: any) => i.name)).toEqual(['phone'])

        const inFilter = await fetchJson(`${app.apiUrl}/products?${encodeURIComponent('status:in')}=${encodeURIComponent(JSON.stringify(['inactive']))}`)
        expect(inFilter.body.items.every((i: any) => i.status === 'inactive')).toBe(true)
        expect(inFilter.body.items.length).toBeGreaterThanOrEqual(1)
    })

    test('cursor paging: :limit + :after walks pages without overlap', async () => {
        const page1 = await fetchJson(`${app.apiUrl}/products?:limit=2&price:sort=asc`)
        expect(page1.body.items.length).toBe(2)
        expect(page1.body.has.next).toBe(true)
        const cursor = page1.body.cursor.last
        expect(cursor).toBeString()

        const page2 = await fetchJson(`${app.apiUrl}/products?:limit=2&price:sort=asc&:after=${encodeURIComponent(cursor)}`)
        expect(page2.body.items.length).toBeGreaterThanOrEqual(1)

        const ids1 = new Set(page1.body.items.map((i: any) => i.id))
        for (const item of page2.body.items) {
            expect(ids1.has(item.id)).toBe(false)
        }
        // ascending price ordering across pages
        const prices = [...page1.body.items, ...page2.body.items].map((i: any) => i.price)
        expect([...prices].sort((a, b) => a - b)).toEqual(prices)
    })

    test('offset paging: :page=2', async () => {
        const page = await fetchJson(`${app.apiUrl}/products?:limit=2&:page=2&price:sort=asc`)
        expect(page.status).toBe(200)
        expect(page.body.items.length).toBeGreaterThanOrEqual(1)
        expect(page.body.page.current).toBe(2)
    })

    test('summary facets via :: keys', async () => {
        const { body } = await fetchJson(`${app.apiUrl}/products?${encodeURIComponent('::total')}=${encodeURIComponent('count()')}`)
        expect(body.summary).toBeDefined()
        // summary keys keep their '::' prefix
        expect(body.summary['::total']).toBeGreaterThanOrEqual(4)
    })

    test('unknown route returns 404 from hono', async () => {
        const { status } = await fetchJson(`${app.apiUrl}/missing`)
        expect(status).toBe(404)
    })
})
