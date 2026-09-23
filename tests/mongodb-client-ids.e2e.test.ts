/**
 * E2E: client-chosen ids against Hono + MongoDatasource + real MongoDB.
 *
 * - An add with a uuidv7 stores it as a BSON UUID `_id`; the document is read, patched and deleted
 *   by that id. A second add with the same id is 409 ID_ALREADY_EXISTS.
 * - Anything but a uuidv7 is 400 INVALID_ID; a legacy `local:` id is ignored (ObjectId assigned).
 * - A collection holding both ObjectId and UUID `_id`s pages through every document exactly once,
 *   in both directions — `$lt`/`$gt` alone would stop at the type boundary.
 * - A real client whose first add loses its response ends with exactly one document.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { UUID } from 'mongodb'
import { uuidv7 } from 'uuidv7'
import { LivequeryClient, LivequeryCollection, LivequeryMemoryStorage } from '../packages/client/src/index.js'
import { RestTransporter } from '../packages/rest/src/RestTransporter.js'
import { buildHonoMongoApp, type AppHandle } from './helpers/servers.js'
import { uniqueCollection } from './helpers/mongo.js'
import { waitFor } from './helpers/wait.js'
import type { Task } from './helpers/client-suite.js'

describe('MongoDatasource with client-chosen ids', () => {
    let app: AppHandle

    const call = async (method: string, path: string, body?: unknown) => {
        const response = await fetch(`${app.apiUrl}/${path}`, {
            method,
            headers: { 'content-type': 'application/json' },
            ...body !== undefined ? { body: JSON.stringify(body) } : {},
        })
        const json = await response.json() as any
        return { status: response.status, body: json?.data ?? json }
    }

    beforeAll(async () => {
        app = await buildHonoMongoApp({ collection: uniqueCollection('client_ids'), ref: 'tasks', realtime: false, wrapData: false })
    }, 60000)

    afterAll(async () => {
        await app?.close()
    }, 30000)

    test('a uuidv7 becomes a BSON UUID _id; read, patch and delete by it', async () => {
        const id = uuidv7()
        const created = await call('POST', 'tasks', { id, title: 'client id', done: false, seq: 1 })
        expect(created.status).toBeLessThan(300)
        expect(created.body.item.id).toBe(id)

        const stored = await app.collection.findOne({ _id: new UUID(id) })
        expect(stored?.title).toBe('client id')

        const read = await call('GET', `tasks/${id}`)
        expect(read.body.item).toMatchObject({ id, title: 'client id' })

        await call('PATCH', `tasks/${id}`, { title: 'patched' })
        expect((await app.collection.findOne({ _id: new UUID(id) }))?.title).toBe('patched')

        await call('DELETE', `tasks/${id}`)
        expect(await app.collection.findOne({ _id: new UUID(id) })).toBeNull()
    })

    test('the same id twice — 409 ID_ALREADY_EXISTS, still one document', async () => {
        const id = uuidv7()
        await call('POST', 'tasks', { id, title: 'first', done: false, seq: 1 })
        const again = await call('POST', 'tasks', { id, title: 'second', done: false, seq: 1 })
        expect(again.status).toBe(409)
        expect(again.body.error?.code ?? again.body.code).toBe('ID_ALREADY_EXISTS')
        expect(await app.collection.countDocuments({ _id: new UUID(id) })).toBe(1)
        expect((await app.collection.findOne({ _id: new UUID(id) }))?.title).toBe('first')
    })

    test('ids that are not uuidv7 are refused; legacy local: ids fall back to an ObjectId', async () => {
        const bad = await call('POST', 'tasks', { id: '66f1c2d3e4f5a6b7c8d9e0f1', title: 'x', done: false, seq: 1 })
        expect(bad.status).toBe(400)
        expect(bad.body.error?.code ?? bad.body.code).toBe('INVALID_ID')

        const legacy = await call('POST', 'tasks', { id: 'local:whatever', title: 'legacy', done: false, seq: 1 })
        expect(legacy.status).toBeLessThan(300)
        expect(legacy.body.item.id).toMatch(/^[0-9a-f]{24}$/)
    })

    test('paging a collection that mixes ObjectId and UUID ids visits every document once', async () => {
        await app.collection.deleteMany({})
        await app.collection.insertMany(Array.from({ length: 7 }, (_, i) => ({ title: `oid-${i}`, done: false, seq: i })))
        for (let i = 0; i < 6; i++) await call('POST', 'tasks', { id: uuidv7(), title: `uuid-${i}`, done: false, seq: 100 + i })
        const total = await app.collection.countDocuments({})
        expect(total).toBe(13)

        for (const sort of [{}, { 'id:sort': 'asc' }]) {
            const seen: string[] = []
            let cursor: string | undefined
            for (let page = 0; page < 10; page++) {
                const query = new URLSearchParams({ ':limit': '4', ...sort, ...cursor ? { ':after': cursor } : {} })
                const { body } = await call('GET', `tasks?${query}`)
                seen.push(...body.items.map((item: any) => item.id))
                if (!body.has?.next) break
                cursor = body.cursor.last
            }
            expect(seen).toHaveLength(13)
            expect(new Set(seen).size).toBe(13)
        }
    })

    test('a real client whose add loses its response ends with exactly one document', async () => {
        let lose = true
        const transporter = new RestTransporter({
            api: app.apiUrl,
            // The server writes, then the answer is lost on the way back.
            onResponse: (request) => {
                if (request.method !== 'POST' || !lose) return
                lose = false
                throw { code: 'NETWORK_ERROR', message: 'response lost' }
            },
        })
        const client = new LivequeryClient({ storage: new LivequeryMemoryStorage(), transporters: { rest: transporter } })
        const col = new LivequeryCollection<Task>(client, { ssr: false, mode: 'local-first' })
        col.initialize('tasks')
        try {
            const result = await col.add({ title: 'exactly-once', done: false, seq: 999 })
            expect(result._queued).toBe(true)
            expect(await app.collection.countDocuments({ title: 'exactly-once' })).toBe(1)

            client.outbox.trigger()
            await waitFor(async () => (await client.outbox.pending()).length === 0, { label: 'retry drained' })
            expect(await app.collection.countDocuments({ title: 'exactly-once' })).toBe(1)
            expect((await app.collection.findOne({ title: 'exactly-once' }))?._id).toEqual(new UUID(result.id))
            const doc = col.items.value.find(d => d.value.id === result.id)?.value
            expect(doc?._adding).toBeUndefined()
            expect(doc?._adding_error).toBeUndefined()
        } finally {
            client.destroy()
        }
    })
})
