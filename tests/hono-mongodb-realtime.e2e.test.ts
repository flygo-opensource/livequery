/**
 * E2E: realtime over the Hono adapter.
 *
 * Raw WS client → WebsocketGateway; subscription registered by the hono livequery
 * middleware on GET (x-lcid/x-lgid headers); changes flow from real MongoDB change
 * streams through MongodbRealtime — wired via honojs createDatasourceMapper's
 * watcher plumbing — into gateway sync events.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { buildHonoMongoApp, type AppHandle } from './helpers/servers.js'
import { uniqueCollection } from './helpers/mongo.js'
import { warmupRealtime } from './helpers/realtime.js'
import { sleep } from './helpers/wait.js'
import { fetchJson, sendJson, waitForWsMessage, wsStart } from './helpers/ws.js'

const COLLECTION = uniqueCollection('hono_rt')

describe('Hono + MongodbRealtime e2e', () => {
    let app: AppHandle

    beforeAll(async () => {
        app = await buildHonoMongoApp({
            collection: COLLECTION,
            ref: 'tasks',
            realtime: true,
            wrapData: false,
        })

        await warmupRealtime(app, 'tasks')
    }, 45000)

    afterAll(async () => {
        await app?.close()
    }, 30000)

    async function subscribe(clientId: string) {
        const { ws, gatewayId } = await wsStart(app.wsUrl, clientId)
        const res = await fetchJson(`${app.apiUrl}/tasks`, {
            headers: { 'x-lcid': clientId, 'x-lgid': gatewayId },
        })
        expect(res.status).toBe(200)
        await sleep(100)
        return { ws, gatewayId }
    }

    test('mongo insert (out-of-band) reaches a subscribed WS client as added', async () => {
        const { ws } = await subscribe('hono-rt-added')
        try {
            const syncP = waitForWsMessage<any>(ws, m =>
                m.event === 'sync' && m.data.changes.some((c: any) => c.type === 'added' && c.data?.title === 'rt-insert'))
            const inserted = await app.collection.insertOne({ title: 'rt-insert', done: false })

            const sync = await syncP
            const change = sync.data.changes.find((c: any) => c.data?.title === 'rt-insert')
            expect(change.data.id).toBe(inserted.insertedId.toString())
            expect(change.ref).toBe('tasks')
            expect(change.type).toBe('added')
        } finally {
            ws.close()
        }
    })

    test('mongo update (out-of-band) emits modified with changed fields', async () => {
        const inserted = await app.collection.insertOne({ title: 'before', done: false, version: 1 })
        const id = inserted.insertedId.toString()
        const { ws } = await subscribe('hono-rt-modified')
        try {
            const syncP = waitForWsMessage<any>(ws, m =>
                m.event === 'sync' && m.data.changes.some((c: any) => c.data?.id === id && c.type === 'modified'))
            await app.collection.updateOne({ _id: inserted.insertedId }, { $set: { title: 'after', version: 2 } })

            const sync = await syncP
            const change = sync.data.changes.find((c: any) => c.data?.id === id)
            expect(change.data.title).toBe('after')
            expect(change.data.version).toBe(2)
        } finally {
            ws.close()
        }
    })

    test('mongo delete emits removed', async () => {
        const inserted = await app.collection.insertOne({ title: 'doomed' })
        const id = inserted.insertedId.toString()
        const { ws } = await subscribe('hono-rt-removed')
        try {
            const syncP = waitForWsMessage<any>(ws, m =>
                m.event === 'sync' && m.data.changes.some((c: any) => c.data?.id === id && c.type === 'removed'))
            await app.collection.deleteOne({ _id: inserted.insertedId })
            const sync = await syncP
            expect(sync.data.changes.find((c: any) => c.data?.id === id).type).toBe('removed')
        } finally {
            ws.close()
        }
    })

    test('mutations made through the HTTP API also produce sync events', async () => {
        const { ws } = await subscribe('hono-rt-api')
        try {
            // POST through the hono datasource handler
            const addedP = waitForWsMessage<any>(ws, m =>
                m.event === 'sync' && m.data.changes.some((c: any) => c.type === 'added' && c.data?.title === 'via-api'))
            const post = await fetchJson(`${app.apiUrl}/tasks`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ title: 'via-api', done: false }),
            })
            expect(post.status).toBe(200)
            const id = post.body.item.id
            await addedP

            // PATCH through the API → modified sync
            const modifiedP = waitForWsMessage<any>(ws, m =>
                m.event === 'sync' && m.data.changes.some((c: any) => c.type === 'modified' && c.data?.id === id))
            await fetchJson(`${app.apiUrl}/tasks/${id}`, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ done: true }),
            })
            const sync = await modifiedP
            expect(sync.data.changes.find((c: any) => c.data?.id === id).data.done).toBe(true)
        } finally {
            ws.close()
        }
    })

    test('GET with cursor params does NOT register a realtime subscription', async () => {
        const clientId = 'hono-rt-cursor'
        const { ws, gatewayId } = await wsStart(app.wsUrl, clientId)
        try {
            let received = false
            ws.addEventListener('message', (e: MessageEvent) => {
                try { if (JSON.parse(e.data).event === 'sync') received = true } catch { /* noop */ }
            })

            await fetchJson(`${app.apiUrl}/tasks?:after=opaque-cursor`, {
                headers: { 'x-lcid': clientId, 'x-lgid': gatewayId },
            })
            await sleep(100)
            await app.collection.insertOne({ title: 'should-not-reach-cursor-client' })
            await sleep(600)

            expect(received).toBe(false)
        } finally {
            ws.close()
        }
    })

    test('client without subscription receives nothing', async () => {
        const { ws } = await wsStart(app.wsUrl, 'hono-rt-nosub')
        try {
            let received = false
            ws.addEventListener('message', (e: MessageEvent) => {
                try { if (JSON.parse(e.data).event === 'sync') received = true } catch { /* noop */ }
            })
            await app.collection.insertOne({ title: 'no-listener' })
            await sleep(600)
            expect(received).toBe(false)
        } finally {
            ws.close()
        }
    })

    test('unsubscribe stops the stream', async () => {
        const clientId = 'hono-rt-unsub'
        const { ws } = await subscribe(clientId)
        try {
            // confirm subscribed
            const syncP = waitForWsMessage<any>(ws, m =>
                m.event === 'sync' && m.data.changes.some((c: any) => c.data?.title === 'pre-unsub'))
            await app.collection.insertOne({ title: 'pre-unsub' })
            await syncP

            sendJson(ws, { event: 'unsubscribe', data: { ref: 'tasks', client_id: clientId } })
            await sleep(150)

            let received = false
            ws.addEventListener('message', (e: MessageEvent) => {
                try { if (JSON.parse(e.data).event === 'sync') received = true } catch { /* noop */ }
            })
            await app.collection.insertOne({ title: 'post-unsub' })
            await sleep(600)
            expect(received).toBe(false)
        } finally {
            ws.close()
        }
    })
})
