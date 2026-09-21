/**
 * E2E: realtime survives a websocket drop + reconnect, thanks to the gateway's
 * disconnect grace window.
 *
 * Scenario: a client subscribes (GET + x-lcid), its socket drops, it reconnects
 * with the SAME client_id within the grace window, and realtime keeps working
 * WITHOUT re-querying. Also pins the negative case: a drop longer than the grace
 * window removes the subscription.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as http from 'http'
import type { AddressInfo } from 'net'
import { WebsocketGateway, WEBSOCKET_PATH } from '../packages/core/build/src/node.js'
import { MongodbRealtime } from '../packages/mongodb/src/index.js'
import { connectMongo, prepareCollection, uniqueCollection, type MongoHandle } from './helpers/mongo.js'
import { DB_NAME } from './helpers/env.js'
import { sleep } from './helpers/wait.js'
import { fetchJson, sendJson, waitForWsMessage, wsStart } from './helpers/ws.js'

const COLLECTION = uniqueCollection('ws_reconnect')

// Small but non-zero grace so the suite runs fast yet exercises the real timer.
const GRACE_MS = 1500

describe('WS drop + reconnect keeps realtime alive (disconnect grace)', () => {
    let server: http.Server
    let gateway: WebsocketGateway
    let mongo: MongoHandle
    let collection: Awaited<ReturnType<typeof prepareCollection>>
    let realtime: any
    let apiBase: string
    let wsUrl: string

    // minimal http surface: GET /livequery/tasks registers the subscription via gateway.handle
    function mountHttp() {
        server.on('request', async (req, res) => {
            const url = new URL(req.url ?? '/', 'http://x')
            if (req.method === 'GET' && url.pathname === '/livequery/tasks') {
                gateway.handle({
                    request: {
                        path: req.url!,
                        ref: '/livequery/tasks',
                        method: 'GET',
                        params: {},
                        query: Object.fromEntries(url.searchParams),
                        body: undefined,
                        headers: new Map(Object.entries(req.headers as Record<string, string>)),
                    },
                    livequery: {
                        ref: 'tasks', collection_ref: 'tasks', schema_collection_ref: 'tasks',
                        document_id: undefined, keys: {}, method: 'GET', path: req.url!, query: {}, body: undefined,
                    } as any,
                } as any)
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ items: [] }))
                return
            }
            res.writeHead(404); res.end('{}')
        })
    }

    beforeAll(async () => {
        mongo = await connectMongo()
        collection = await prepareCollection(mongo.db, COLLECTION)

        server = http.createServer()
        gateway = new WebsocketGateway(server, { disconnectGraceMs: GRACE_MS })
        mountHttp()
        await new Promise<void>(resolve => server.listen(0, resolve))
        const port = (server.address() as AddressInfo).port
        apiBase = `http://127.0.0.1:${port}/livequery`
        wsUrl = `ws://127.0.0.1:${port}${WEBSOCKET_PATH}`

        realtime = new MongodbRealtime()
            .watch(
                { connections: { default: mongo.client }, databases: [DB_NAME] },
                [{ schema: 'tasks', options: { collection: COLLECTION, db: DB_NAME, realtime: true } }],
            )
            .subscribe(update => gateway.next(update as any))

        // warm up the change stream
        const probe = await wsStart(wsUrl, 'warmup')
        await fetchJson(`${apiBase}/tasks`, { headers: { 'x-lcid': 'warmup', 'x-lgid': gateway.id } })
        await sleep(100)
        let ready = false
        probe.ws.addEventListener('message', (e: MessageEvent) => {
            try { if (JSON.parse(e.data).event === 'sync') ready = true } catch { /* noop */ }
        })
        const started = Date.now()
        while (!ready && Date.now() - started < 20000) {
            await collection.insertOne({ __warmup: true })
            await sleep(300)
        }
        probe.ws.close()
        if (!ready) throw new Error('change stream never became ready')
        await collection.deleteMany({ __warmup: true })
        await sleep(500)
    }, 45000)

    afterAll(async () => {
        realtime?.unsubscribe?.()
        gateway?.close()
        await new Promise<void>(resolve => {
            try { (server as any).closeAllConnections?.() } catch { /* noop */ }
            server.close(() => resolve())
        })
        await collection?.deleteMany({}).catch(() => undefined)
        await mongo?.close()
    }, 30000)

    async function subscribe(clientId: string) {
        const { ws, gatewayId } = await wsStart(wsUrl, clientId)
        await fetchJson(`${apiBase}/tasks`, { headers: { 'x-lcid': clientId, 'x-lgid': gatewayId } })
        await sleep(100)
        return { ws, gatewayId }
    }

    test('reconnect within grace window resumes realtime WITHOUT re-querying', async () => {
        const clientId = 'reconnect-fast'
        const first = await subscribe(clientId)

        // confirm realtime works before the drop
        const p0 = waitForWsMessage<any>(first.ws, m => m.event === 'sync' && m.data.changes.some((c: any) => c.data?.title === 'before-drop'))
        await collection.insertOne({ title: 'before-drop' })
        await p0

        // drop the socket
        first.ws.close()
        await sleep(300) // well within GRACE_MS

        // reconnect with the SAME client_id, do NOT issue a new GET
        const { ws } = await wsStart(wsUrl, clientId)
        try {
            await sleep(150)
            const p1 = waitForWsMessage<any>(ws, m => m.event === 'sync' && m.data.changes.some((c: any) => c.data?.title === 'after-reconnect'))
            await collection.insertOne({ title: 'after-reconnect' })
            const sync = await p1
            expect(sync.data.changes.find((c: any) => c.data?.title === 'after-reconnect').type).toBe('added')
        } finally {
            ws.close()
        }
    })

    test('drop longer than the grace window removes the subscription (reconnect gets nothing without re-query)', async () => {
        const clientId = 'reconnect-slow'
        const first = await subscribe(clientId)
        first.ws.close()
        await sleep(GRACE_MS + 600) // outlast the grace window

        const { ws } = await wsStart(wsUrl, clientId)
        try {
            let got = false
            ws.addEventListener('message', (e: MessageEvent) => {
                try { if (JSON.parse(e.data).event === 'sync') got = true } catch { /* noop */ }
            })
            await collection.insertOne({ title: 'after-grace-expired' })
            await sleep(800)
            expect(got).toBe(false)

            // but re-querying (new GET) restores realtime
            await fetchJson(`${apiBase}/tasks`, { headers: { 'x-lcid': clientId, 'x-lgid': first.gatewayId } })
            await sleep(150)
            const p = waitForWsMessage<any>(ws, m => m.event === 'sync' && m.data.changes.some((c: any) => c.data?.title === 'requeried'))
            await collection.insertOne({ title: 'requeried' })
            await p
        } finally {
            ws.close()
        }
    })

    test('a dropped client inside its grace window does not block delivery to a live client', async () => {
        const live = await subscribe('reconnect-live')
        const dropping = await subscribe('reconnect-dropping')

        dropping.ws.close() // enters grace window, subscription still held
        await sleep(200)

        try {
            // the still-connected client must keep receiving; the dead socket is skipped
            const p = waitForWsMessage<any>(live.ws, m => m.event === 'sync' && m.data.changes.some((c: any) => c.data?.title === 'fanout-with-dead-peer'))
            await collection.insertOne({ title: 'fanout-with-dead-peer' })
            const sync = await p
            expect(sync.data.changes.find((c: any) => c.data?.title === 'fanout-with-dead-peer')).toBeDefined()
        } finally {
            live.ws.close()
        }
    })
})
