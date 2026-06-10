/**
 * E2E: realtime correctness when HTTP requests ROTATE across multiple API gateways.
 *
 * Topology (production-like):
 *
 *            ┌── API gateway A (ApiGatewayHandler + WebsocketGateway) ──┐
 *   client ──┤                                                          ├── service node
 *    (WS@A)  └── API gateway B (ApiGatewayHandler + WebsocketGateway) ──┘   (NestJS +
 *                                                                            MongoDatasource +
 *                Both gateways bridge to the service's gateway               MongodbRealtime)
 *
 * The client holds ONE websocket (gateway A) while its HTTP requests are proxied
 * through A and B alternately. The service must register subscriptions against the
 * client's WS gateway (from the x-lcid/x-lgid headers, preserved through whichever
 * proxy handled the request) and route every sync event back through gateway A.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as http from 'http'
import type { AddressInfo } from 'net'
import { Subject } from '../core/node_modules/rxjs/dist/cjs/index.js'
import { ApiGatewayHandler, WebsocketGateway, WEBSOCKET_PATH } from '../core/build/src/index.js'
import { buildNestMongoApp, type AppHandle } from './helpers/servers.js'
import { uniqueCollection } from './helpers/mongo.js'
import { warmupRealtime } from './helpers/realtime.js'
import { sleep } from './helpers/wait.js'
import { fetchJson, waitForWsMessage, wsStart } from './helpers/ws.js'

const COLLECTION = uniqueCollection('gw_rotation')

type GatewayNode = {
    name: string
    server: http.Server
    gateway: WebsocketGateway
    handler: ApiGatewayHandler
    bridge: { unsubscribe(): void }
    apiUrl: string
    wsUrl: string
}

// ApiGatewayHandler spins up UDP multicast discovery by default — irrelevant here,
// services are registered statically.
function fakeDiscovery() {
    return Object.assign(new Subject<any>(), {
        broadcast: async () => { },
        close: () => { },
    }) as any
}

async function startApiGateway(name: string, service: AppHandle): Promise<GatewayNode> {
    const server = http.createServer()
    const gateway = new WebsocketGateway(server)
    const handler = new ApiGatewayHandler({ ws: gateway, discovery: fakeDiscovery(), node_id: name })
    handler.register({
        node_id: 'service-node',
        hostname: '127.0.0.1',
        port: service.port,
        paths: [
            { method: 'GET', path: 'livequery/tasks' },
            { method: 'GET', path: 'livequery/tasks/:id' },
            { method: 'POST', path: 'livequery/tasks' },
            { method: 'PATCH', path: 'livequery/tasks/:id' },
            { method: 'DELETE', path: 'livequery/tasks/:id' },
        ],
    })

    server.on('request', (req, res) => {
        const chunks: Buffer[] = []
        req.on('data', c => chunks.push(c as Buffer))
        req.on('end', () => {
            ; (req as any).rawBody = Buffer.concat(chunks)
            // Same identity forwarding as nestjs ApiGatewayLinker: keep the client's
            // x-lgid if present, fall back to THIS gateway's id otherwise.
            const client_id = (req.headers['x-lcid'] ?? req.headers['socket_id']) as string | undefined
            const extra = client_id ? {
                'x-lcid': client_id,
                'x-lgid': (req.headers['x-lgid'] as string) || gateway.id,
            } : undefined
            handler.fetch(req as any, res, extra)
        })
    })

    await new Promise<void>(resolve => server.listen(0, resolve))
    const port = (server.address() as AddressInfo).port

    // Gateway-to-gateway bridge: the API gateway connects to the service's gateway so
    // the service can route sync events back through it to WS clients.
    const bridge = gateway.connect(service.wsUrl, (service.gateway as any).auth)

    return {
        name,
        server,
        gateway,
        handler,
        bridge,
        apiUrl: `http://127.0.0.1:${port}/livequery`,
        wsUrl: `ws://127.0.0.1:${port}${WEBSOCKET_PATH}`,
    }
}

async function closeGateway(node: GatewayNode) {
    node.bridge.unsubscribe()
    node.handler.close()
    node.gateway.close()
    await new Promise<void>(resolve => {
        try { (node.server as any).closeAllConnections?.() } catch { /* noop */ }
        node.server.close(() => resolve())
    })
}

describe('HTTP rotation across API gateways keeps realtime routing correct', () => {
    let service: AppHandle
    let gwA: GatewayNode
    let gwB: GatewayNode

    beforeAll(async () => {
        service = await buildNestMongoApp({ collection: COLLECTION, ref: 'tasks', realtime: true })
        await warmupRealtime(service, 'tasks')

        gwA = await startApiGateway('gateway-a', service)
        gwB = await startApiGateway('gateway-b', service)
        await sleep(400) // let both gateway bridges finish their hello handshake
    }, 60000)

    afterAll(async () => {
        await closeGateway(gwA)
        await closeGateway(gwB)
        await service?.close()
    }, 30000)

    test('subscription via gateway A, then requests via gateway B — client (WS@A) keeps receiving', async () => {
        const clientId = 'rotate-client-1'
        const { ws, gatewayId } = await wsStart(gwA.wsUrl, clientId)
        const headers = { 'x-lcid': clientId, 'x-lgid': gatewayId }
        try {
            // subscribe through gateway A
            const viaA = await fetchJson(`${gwA.apiUrl}/tasks`, { headers })
            expect(viaA.status).toBe(200)
            expect(Array.isArray(viaA.body.data.items)).toBe(true)
            await sleep(150)

            const sync1 = waitForWsMessage<any>(ws, m =>
                m.event === 'sync' && m.data.changes.some((c: any) => c.data?.title === 'sub-via-a'))
            await service.collection.insertOne({ title: 'sub-via-a', done: false })
            await sync1

            // now the SAME client queries through gateway B (x-lgid still = gateway A)
            const viaB = await fetchJson(`${gwB.apiUrl}/tasks`, { headers })
            expect(viaB.status).toBe(200)
            await sleep(150)

            const sync2 = waitForWsMessage<any>(ws, m =>
                m.event === 'sync' && m.data.changes.some((c: any) => c.data?.title === 'sub-via-b'))
            await service.collection.insertOne({ title: 'sub-via-b', done: false })
            await sync2
        } finally {
            ws.close()
        }
    })

    test('mutations rotated across both gateways all come back as realtime events, exactly once', async () => {
        const clientId = 'rotate-client-2'
        const { ws, gatewayId } = await wsStart(gwA.wsUrl, clientId)
        const headers = { 'x-lcid': clientId, 'x-lgid': gatewayId, 'content-type': 'application/json' }
        const received: any[] = []
        ws.addEventListener('message', (e: MessageEvent) => {
            try {
                const msg = JSON.parse(e.data)
                if (msg.event === 'sync') received.push(...msg.data.changes)
            } catch { /* noop */ }
        })
        try {
            await fetchJson(`${gwA.apiUrl}/tasks`, { headers })
            await sleep(150)

            // POST through B → added
            const post1 = await fetchJson(`${gwB.apiUrl}/tasks`, {
                method: 'POST', headers, body: JSON.stringify({ title: 'rot-0', done: false }),
            })
            expect(post1.status).toBe(201)
            const id0 = post1.body.data.item.id

            // PATCH through A → modified
            const patch = await fetchJson(`${gwA.apiUrl}/tasks/${id0}`, {
                method: 'PATCH', headers, body: JSON.stringify({ done: true }),
            })
            expect(patch.status).toBe(200)

            // POST through A → added
            const post2 = await fetchJson(`${gwA.apiUrl}/tasks`, {
                method: 'POST', headers, body: JSON.stringify({ title: 'rot-1', done: false }),
            })
            expect(post2.status).toBe(201)

            // DELETE through B → removed
            const del = await fetchJson(`${gwB.apiUrl}/tasks/${id0}`, { method: 'DELETE', headers })
            expect(del.status).toBe(200)

            // every mutation must surface exactly once at the WS client on gateway A
            const started = Date.now()
            while (Date.now() - started < 15000) {
                const added0 = received.filter(c => c.type === 'added' && c.data?.title === 'rot-0').length
                const modified0 = received.filter(c => c.type === 'modified' && c.data?.id === id0).length
                const added1 = received.filter(c => c.type === 'added' && c.data?.title === 'rot-1').length
                const removed0 = received.filter(c => c.type === 'removed' && c.data?.id === id0).length
                if (added0 >= 1 && modified0 >= 1 && added1 >= 1 && removed0 >= 1) break
                await sleep(50)
            }
            await sleep(500) // grace period to catch duplicates

            expect(received.filter(c => c.type === 'added' && c.data?.title === 'rot-0').length).toBe(1)
            expect(received.filter(c => c.type === 'modified' && c.data?.id === id0).length).toBe(1)
            expect(received.filter(c => c.type === 'added' && c.data?.title === 'rot-1').length).toBe(1)
            expect(received.filter(c => c.type === 'removed' && c.data?.id === id0).length).toBe(1)
        } finally {
            ws.close()
        }
    })

    test('reverse direction: client WS@B subscribing through gateway A still receives at B', async () => {
        const clientId = 'rotate-client-3'
        const { ws, gatewayId } = await wsStart(gwB.wsUrl, clientId)
        try {
            await fetchJson(`${gwA.apiUrl}/tasks`, { headers: { 'x-lcid': clientId, 'x-lgid': gatewayId } })
            await sleep(150)

            const syncP = waitForWsMessage<any>(ws, m =>
                m.event === 'sync' && m.data.changes.some((c: any) => c.data?.title === 'reverse-route'))
            await service.collection.insertOne({ title: 'reverse-route', done: false })
            await syncP
        } finally {
            ws.close()
        }
    })

    test('without x-lgid the proxying gateway injects its own id — events go to the wrong gateway (documented)', async () => {
        const clientId = 'rotate-client-4'
        const { ws } = await wsStart(gwA.wsUrl, clientId) // WS at A
        try {
            // request via B WITHOUT x-lgid → B's fallback points the subscription at B
            await fetchJson(`${gwB.apiUrl}/tasks`, { headers: { 'x-lcid': clientId } })
            await sleep(150)

            let got = false
            ws.addEventListener('message', (e: MessageEvent) => {
                try { if (JSON.parse(e.data).event === 'sync') got = true } catch { /* noop */ }
            })
            await service.collection.insertOne({ title: 'misrouted', done: false })
            await sleep(800)

            // the client at A never sees it — this is why transporters MUST send x-lgid
            expect(got).toBe(false)
        } finally {
            ws.close()
        }
    })
})
