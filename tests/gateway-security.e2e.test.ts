/**
 * E2E: gateway security / isolation.
 *
 *  #2 WS subscribe-bypass — what happens when a plain client socket sends a raw
 *     `subscribe` frame directly (no HTTP auth layer in front)?
 *  #3 gateway-to-gateway auth — a peer connecting with the wrong auth token.
 *  + realtime payloads must hide private (`_`) fields, same as HTTP responses.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as http from 'http'
import type { AddressInfo } from 'net'
import { WebsocketGateway, WEBSOCKET_PATH } from '../core/build/src/node.js'
import { MongodbRealtime } from '../mongodb/src/index.js'
import { connectMongo, prepareCollection, uniqueCollection, type MongoHandle } from './helpers/mongo.js'
import { DB_NAME } from './helpers/env.js'
import { sleep } from './helpers/wait.js'
import { sendJson, waitForWsMessage, wsConnect, wsStart } from './helpers/ws.js'

const COLLECTION = uniqueCollection('gw_security')

describe('Gateway security & isolation e2e', () => {
    let server: http.Server
    let gateway: WebsocketGateway
    let mongo: MongoHandle
    let collection: Awaited<ReturnType<typeof prepareCollection>>
    let realtime: any
    let wsUrl: string

    beforeAll(async () => {
        mongo = await connectMongo()
        collection = await prepareCollection(mongo.db, COLLECTION)

        server = http.createServer((_req, res) => { res.writeHead(404); res.end('{}') })
        gateway = new WebsocketGateway(server)
        await new Promise<void>(resolve => server.listen(0, resolve))
        wsUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${WEBSOCKET_PATH}`

        realtime = new MongodbRealtime()
            .watch(
                { connections: { default: mongo.client }, databases: [DB_NAME] },
                [{ schema: 'tasks', options: { collection: COLLECTION, db: DB_NAME, realtime: true } }],
            )
            .subscribe(update => gateway.next(update as any))

        // warm up
        const probe = await wsStart(wsUrl, 'warmup')
        gateway.listen([{ ref: 'tasks', client_id: 'warmup', gateway_id: gateway.id, listener_node_id: gateway.id }])
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

    // ── #2 WS subscribe is server-side only ─────────────────────────────────────
    // A `subscribe` frame carries its own ref and client_id, so honouring it from a plain client
    // would bypass whatever guards a ref (the GET that registers it). The gateway ignores it
    // unless `allowClientSubscribe` is set for a trusted network.
    test('a raw subscribe frame from a plain client is ignored', async () => {
        const clientId = 'bypass-client'
        const { ws } = await wsStart(wsUrl, clientId)
        try {
            // no HTTP GET — the client tries to self-subscribe over the socket
            sendJson(ws, { event: 'subscribe', ref: 'tasks', client_id: clientId, gateway_id: gateway.id, listener_node_id: gateway.id })
            await sleep(150)

            let received = false
            ws.addEventListener('message', (e: MessageEvent) => {
                try { if (JSON.parse(e.data).event === 'sync') received = true } catch { /* noop */ }
            })
            await collection.insertOne({ title: 'not-delivered' })
            await sleep(700)
            expect(received).toBe(false)
        } finally {
            ws.close()
        }
    })

    test('a client cannot subscribe ON BEHALF OF a different client_id it does not own', async () => {
        // attacker socket tries to register a victim's client_id pointing at this gateway.
        // The victim (never connected) has no socket; the attacker should not receive the
        // victim's events on its own socket (delivery is keyed to the victim's connection).
        const attacker = await wsStart(wsUrl, 'attacker')
        try {
            sendJson(attacker.ws, { event: 'subscribe', ref: 'tasks', client_id: 'victim-id', gateway_id: gateway.id, listener_node_id: gateway.id })
            await sleep(150)

            let attackerGot = false
            attacker.ws.addEventListener('message', (e: MessageEvent) => {
                try { if (JSON.parse(e.data).event === 'sync') attackerGot = true } catch { /* noop */ }
            })
            await collection.insertOne({ title: 'not-for-attacker' })
            await sleep(700)
            // events for victim-id route to victim-id's connection (which is the attacker's
            // socket only if the attacker authed as victim-id — it didn't). The attacker
            // socket is registered under 'attacker', so it receives nothing for victim-id.
            expect(attackerGot).toBe(false)
        } finally {
            attacker.ws.close()
        }
    })

    // ── realtime private-field hiding ───────────────────────────────────────────
    test('realtime sync payloads strip private (_) fields', async () => {
        const clientId = 'privacy-client'
        const { ws } = await wsStart(wsUrl, clientId)
        try {
            gateway.listen([{ ref: 'tasks', client_id: clientId, gateway_id: gateway.id, listener_node_id: gateway.id }])
            await sleep(100)

            const p = waitForWsMessage<any>(ws, m => m.event === 'sync' && m.data.changes.some((c: any) => c.data?.title === 'has-secret'))
            await collection.insertOne({ title: 'has-secret', _secret: 'do-not-leak', _internal: 42 })
            const sync = await p
            const change = sync.data.changes.find((c: any) => c.data?.title === 'has-secret')
            expect(change.data.title).toBe('has-secret')
            expect(change.data._secret).toBeUndefined()
            expect(change.data._internal).toBeUndefined()
            expect(change.data.id).toBeString()
        } finally {
            ws.close()
        }
    })

    // ── #3 gateway-to-gateway auth ──────────────────────────────────────────────
    test('a peer gateway connecting with the WRONG auth token is rejected', async () => {
        // Raw WS posing as a gateway with a bad auth token.
        const rogue = await wsConnect(wsUrl)
        try {
            const closed = new Promise<void>(resolve => rogue.addEventListener('close', () => resolve()))
            let helloed = false
            rogue.addEventListener('message', (e: MessageEvent) => {
                try { if (JSON.parse(e.data).event === 'hello') helloed = true } catch { /* noop */ }
            })
            sendJson(rogue, { event: 'start', data: { id: 'rogue-gateway', auth: 'totally-wrong-token' } })
            // _onStart closes the socket on auth mismatch → no hello
            await Promise.race([closed, sleep(800)])
            expect(helloed).toBe(false)
            expect(rogue.readyState).not.toBe(WebSocket.OPEN)
        } finally {
            try { rogue.close() } catch { /* already closed */ }
        }
    })

    test('a peer gateway with the CORRECT auth establishes and relays subscriptions', async () => {
        const peerServer = http.createServer((_req, res) => { res.writeHead(404); res.end('{}') })
        const peer = new WebsocketGateway(peerServer)
        await new Promise<void>(resolve => peerServer.listen(0, resolve))
        const peerWsUrl = `ws://127.0.0.1:${(peerServer.address() as AddressInfo).port}${WEBSOCKET_PATH}`

        // peer bridges INTO our gateway with the correct auth
        const bridge = peer.gateway?.connect
            ? peer.connect(wsUrl, gateway.auth)
            : peer.connect(wsUrl, gateway.auth)
        await sleep(400)

        // a client on the peer, subscription routed to our gateway, event emitted on ours
        const clientId = 'peer-client'
        const { ws, gatewayId } = await wsStart(peerWsUrl, clientId)
        try {
            // register subscription on OUR gateway pointing back to the peer
            gateway.listen([{ ref: 'tasks', client_id: clientId, gateway_id: gatewayId, listener_node_id: gateway.id }])
            await sleep(200)

            const p = waitForWsMessage<any>(ws, m => m.event === 'sync' && m.data.changes.some((c: any) => c.data?.title === 'cross-auth-ok'), 8000)
            await collection.insertOne({ title: 'cross-auth-ok' })
            const sync = await p
            expect(sync.data.changes.find((c: any) => c.data?.title === 'cross-auth-ok')).toBeDefined()
        } finally {
            ws.close()
            bridge.unsubscribe()
            peer.close()
            await new Promise<void>(resolve => {
                try { (peerServer as any).closeAllConnections?.() } catch { /* noop */ }
                peerServer.close(() => resolve())
            })
        }
    })
})
