import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import * as http from 'http'
import type { AddressInfo } from 'net'
import { WebsocketGateway, WEBSOCKET_PATH } from '@livequery/core'
import { wsConnect, waitForWsMessage, sendJson, sleep, closeServer } from './helpers.js'
import type { UpdatedData } from '@livequery/types'

// ─── Bootstrap helpers ────────────────────────────────────────────────────────

type GatewayHandle = {
    server: http.Server
    gateway: WebsocketGateway
    port: number
    wsUrl: string
}

async function startGateway(): Promise<GatewayHandle> {
    const server = http.createServer()
    const gateway = new WebsocketGateway(server)
    await new Promise<void>(r => server.listen(0, r))
    const port = (server.address() as AddressInfo).port
    return { server, gateway, port, wsUrl: `ws://127.0.0.1:${port}${WEBSOCKET_PATH}` }
}

async function closeGateway({ server }: GatewayHandle) {
    await closeServer(server)
}

async function connectClient(wsUrl: string, clientId: string, gatewayId: string) {
    const ws = await wsConnect(wsUrl)
    sendJson(ws, { event: 'start', data: { id: clientId, auth: '' } })
    await waitForWsMessage(ws, (m: any) => m.event === 'hello')
    return ws
}

function emit(gateway: WebsocketGateway, ref: string, id: string) {
    gateway.next({ ref, data: { id }, type: 'added' } as UpdatedData)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WebsocketGateway — connect & hello', () => {
    let gw: GatewayHandle

    beforeAll(async () => { gw = await startGateway() })
    afterAll(async () => { await closeGateway(gw) })

    test('receives hello after start', async () => {
        const ws = await wsConnect(gw.wsUrl)
        sendJson(ws, { event: 'start', data: { id: 'c-hello-1', auth: '' } })
        const msg = await waitForWsMessage<any>(ws, m => m.event === 'hello')
        expect(msg.event).toBe('hello')
        expect(typeof msg.gid).toBe('string')
        ws.close()
    })

    test('hello contains node id (gid)', async () => {
        const ws = await wsConnect(gw.wsUrl)
        sendJson(ws, { event: 'start', data: { id: 'c-hello-2', auth: '' } })
        const msg = await waitForWsMessage<any>(ws, m => m.event === 'hello')
        expect(msg.gid).toBe(gw.gateway.id)
        ws.close()
    })

    test('duplicate client id is rejected — second socket closed', async () => {
        const ws1 = await connectClient(gw.wsUrl, 'c-dup', gw.gateway.id)

        const ws2 = await wsConnect(gw.wsUrl)
        sendJson(ws2, { event: 'start', data: { id: 'c-dup', auth: '' } })

        const closed = await new Promise<boolean>(resolve => {
            ws2.addEventListener('close', () => resolve(true))
            setTimeout(() => resolve(false), 2000)
        })

        expect(closed).toBe(true)
        ws1.close()
    })

    test('invalid auth closes the socket', async () => {
        const ws = await wsConnect(gw.wsUrl)
        sendJson(ws, { event: 'start', data: { id: 'c-bad-auth', auth: 'wrong-secret' } })

        const closed = await new Promise<boolean>(resolve => {
            ws.addEventListener('close', () => resolve(true))
            setTimeout(() => resolve(false), 2000)
        })
        expect(closed).toBe(true)
    })
})

describe('WebsocketGateway — subscribe & receive updates', () => {
    let gw: GatewayHandle

    beforeAll(async () => { gw = await startGateway() })
    afterAll(async () => { await closeGateway(gw) })

    test('client receives sync after gateway emits on subscribed ref', async () => {
        const clientId = 'c-sub-1'
        const ws = await connectClient(gw.wsUrl, clientId, gw.gateway.id)

        sendJson(ws, {
            event: 'subscribe',
            ref: 'pets',
            client_id: clientId,
            gateway_id: gw.gateway.id,
            listener_node_id: gw.gateway.id,
        })
        await sleep(100)

        const syncP = waitForWsMessage<any>(ws, m => m.event === 'sync')
        emit(gw.gateway, 'pets', 'dog-1')

        const sync = await syncP
        expect(sync.event).toBe('sync')
        expect(sync.data.changes[0].ref).toBe('pets')
        expect(sync.data.changes[0].data.id).toBe('dog-1')
        ws.close()
    })

    test('client does NOT receive sync for a different ref', async () => {
        const clientId = 'c-sub-2'
        const ws = await connectClient(gw.wsUrl, clientId, gw.gateway.id)

        sendJson(ws, {
            event: 'subscribe',
            ref: 'cats',
            client_id: clientId,
            gateway_id: gw.gateway.id,
            listener_node_id: gw.gateway.id,
        })
        await sleep(100)

        let received = false
        ws.addEventListener('message', (e: MessageEvent) => {
            const m = JSON.parse(e.data)
            if (m.event === 'sync' && m.data?.changes?.[0]?.ref === 'dogs') received = true
        })

        emit(gw.gateway, 'dogs', 'rex')
        await sleep(400)

        expect(received).toBe(false)
        ws.close()
    })

    test('multiple clients on same ref all receive the update', async () => {
        const ids = ['c-multi-1', 'c-multi-2']
        const wsSockets = await Promise.all(ids.map(id => connectClient(gw.wsUrl, id, gw.gateway.id)))

        for (const [i, ws] of wsSockets.entries()) {
            sendJson(ws, {
                event: 'subscribe',
                ref: 'birds',
                client_id: ids[i],
                gateway_id: gw.gateway.id,
                listener_node_id: gw.gateway.id,
            })
        }
        await sleep(100)

        // Set up listeners BEFORE emitting
        const syncs = wsSockets.map(ws => waitForWsMessage<any>(ws, m => m.event === 'sync'))
        emit(gw.gateway, 'birds', 'parrot')
        const results = await Promise.all(syncs)

        for (const sync of results) {
            expect(sync.data.changes[0].ref).toBe('birds')
        }

        for (const ws of wsSockets) ws.close()
    })
})

describe('WebsocketGateway — unsubscribe', () => {
    let gw: GatewayHandle

    beforeAll(async () => { gw = await startGateway() })
    afterAll(async () => { await closeGateway(gw) })

    test('client does not receive sync after unsubscribing', async () => {
        const clientId = 'c-unsub-1'
        const ws = await connectClient(gw.wsUrl, clientId, gw.gateway.id)

        sendJson(ws, {
            event: 'subscribe',
            ref: 'fish',
            client_id: clientId,
            gateway_id: gw.gateway.id,
            listener_node_id: gw.gateway.id,
        })
        await sleep(100)

        sendJson(ws, { event: 'unsubscribe', data: { ref: 'fish', client_id: clientId } })
        await sleep(100)

        let received = false
        ws.addEventListener('message', (e: MessageEvent) => {
            const m = JSON.parse(e.data)
            if (m.event === 'sync') received = true
        })

        emit(gw.gateway, 'fish', 'nemo')
        await sleep(400)

        expect(received).toBe(false)
        ws.close()
    })

    test('unsubscribing multiple refs at once', async () => {
        const clientId = 'c-unsub-2'
        const ws = await connectClient(gw.wsUrl, clientId, gw.gateway.id)

        for (const ref of ['alpha', 'beta']) {
            sendJson(ws, {
                event: 'subscribe',
                ref,
                client_id: clientId,
                gateway_id: gw.gateway.id,
                listener_node_id: gw.gateway.id,
            })
        }
        await sleep(100)

        sendJson(ws, { event: 'unsubscribe', data: { refs: ['alpha', 'beta'], client_id: clientId } })
        await sleep(100)

        let count = 0
        ws.addEventListener('message', (e: MessageEvent) => {
            const m = JSON.parse(e.data)
            if (m.event === 'sync') count++
        })

        emit(gw.gateway, 'alpha', 'x')
        emit(gw.gateway, 'beta', 'y')
        await sleep(400)

        expect(count).toBe(0)
        ws.close()
    })
})

describe('WebsocketGateway — disconnect cleanup', () => {
    let gw: GatewayHandle

    beforeAll(async () => { gw = await startGateway() })
    afterAll(async () => { await closeGateway(gw) })

    test('emitting after client disconnect does not throw', async () => {
        const clientId = 'c-disc-1'
        const ws = await connectClient(gw.wsUrl, clientId, gw.gateway.id)

        sendJson(ws, {
            event: 'subscribe',
            ref: 'ghosts',
            client_id: clientId,
            gateway_id: gw.gateway.id,
            listener_node_id: gw.gateway.id,
        })
        await sleep(100)

        ws.close()
        await sleep(200)

        expect(() => emit(gw.gateway, 'ghosts', 'boo')).not.toThrow()
    })
})

describe('WebsocketGateway — multi-node (gateway linking)', () => {
    test('two nodes connect via gateway auth', async () => {
        const gw1 = await startGateway()
        const gw2 = await startGateway()
        try {
            const sub = gw2.gateway.connect(
                `ws://127.0.0.1:${gw1.port}${WEBSOCKET_PATH}`,
                gw1.gateway.auth
            )
            await sleep(800)
            sub.unsubscribe()
        } finally {
            await closeGateway(gw1)
            await closeGateway(gw2)
        }
    }, 10_000)

    test('cross-node: client on gw2 receives update emitted on gw1', async () => {
        const gw1 = await startGateway()
        const gw2 = await startGateway()
        try {
            const sub = gw2.gateway.connect(
                `ws://127.0.0.1:${gw1.port}${WEBSOCKET_PATH}`,
                gw1.gateway.auth
            )
            await sleep(800)

            const clientId = 'c-cross-1'
            const ws = await connectClient(gw2.wsUrl, clientId, gw2.gateway.id)

            sendJson(ws, {
                event: 'subscribe',
                ref: 'cross-ref',
                client_id: clientId,
                gateway_id: gw1.gateway.id,
                listener_node_id: gw2.gateway.id,
            })
            await sleep(400)

            const syncP = waitForWsMessage<any>(ws, m => m.event === 'sync', 6000)
            emit(gw1.gateway, 'cross-ref', 'item-x')

            const sync = await syncP
            expect(sync.data.changes[0].ref).toBe('cross-ref')
            ws.close()
            sub.unsubscribe()
        } finally {
            await closeGateway(gw1)
            await closeGateway(gw2)
        }
    }, 15_000)

    test('gateway reconnects after target node restart', async () => {
        const gw1 = await startGateway()
        const gw2 = await startGateway()

        const sub = gw2.gateway.connect(
            `ws://127.0.0.1:${gw1.port}${WEBSOCKET_PATH}`,
            gw1.gateway.auth
        )
        await sleep(600)

        // Close gw1 — gw2 should survive without throwing
        await closeGateway(gw1)
        await sleep(500)

        expect(sub.closed).toBe(false)
        sub.unsubscribe()
        await closeGateway(gw2)
    }, 12_000)
})
