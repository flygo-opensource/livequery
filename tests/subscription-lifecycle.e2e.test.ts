/**
 * E2E: subscription lifecycle & leak checks (#5).
 *
 * Repeated subscribe/unsubscribe and connect/disconnect cycles must not leak
 * entries in the gateway's internal `_subscriptions` / `_connections` maps, and a
 * ref with no remaining subscribers must tear down its pipe.
 */

import { afterEach, beforeAll, afterAll, describe, expect, test } from 'bun:test'
import * as http from 'http'
import type { AddressInfo } from 'net'
import { WebsocketGateway, WEBSOCKET_PATH } from '../core/build/src/node.js'
import { sleep, waitFor } from './helpers/wait.js'
import { sendJson, wsStart } from './helpers/ws.js'

// Inspect protected maps for leak assertions.
type Internals = {
    _subscriptions: Map<string, Map<string, unknown>>
    _connections: Map<string, unknown>
    _pendingDisconnects: Map<string, unknown>
}

describe('Subscription lifecycle & leak e2e', () => {
    let server: http.Server
    let gateway: WebsocketGateway
    let wsUrl: string
    let internals: Internals

    beforeAll(async () => {
        server = http.createServer((_req, res) => { res.writeHead(404); res.end('{}') })
        // tiny grace so disconnect cleanup is observable quickly
        gateway = new WebsocketGateway(server, { disconnectGraceMs: 100 })
        internals = gateway as unknown as Internals
        await new Promise<void>(resolve => server.listen(0, resolve))
        wsUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${WEBSOCKET_PATH}`
    })

    afterAll(async () => {
        gateway.close()
        await new Promise<void>(resolve => {
            try { (server as any).closeAllConnections?.() } catch { /* noop */ }
            server.close(() => resolve())
        })
    })

    afterEach(async () => {
        // each test should leave the gateway clean
        await waitFor(() => internals._subscriptions.size === 0, { label: 'subscriptions drained', timeout: 4000 })
    })

    test('explicit subscribe → unsubscribe leaves no subscription entry', async () => {
        const clientId = 'lifecycle-1'
        const { ws } = await wsStart(wsUrl, clientId)
        try {
            gateway.listen([{ ref: 'tasks', client_id: clientId, gateway_id: gateway.id, listener_node_id: gateway.id }])
            await sleep(50)
            expect(internals._subscriptions.get('tasks')?.has(clientId)).toBe(true)

            gateway.detach(clientId, 'tasks')
            await sleep(50)
            expect(internals._subscriptions.has('tasks')).toBe(false) // ref dropped when last subscriber leaves
        } finally {
            ws.close()
            await sleep(200)
        }
    })

    test('100 subscribe/unsubscribe cycles do not grow the maps', async () => {
        const clientId = 'lifecycle-churn'
        const { ws } = await wsStart(wsUrl, clientId)
        try {
            for (let i = 0; i < 100; i++) {
                const ref = `things/${i % 5}` // cycle a handful of refs
                gateway.listen([{ ref, client_id: clientId, gateway_id: gateway.id, listener_node_id: gateway.id }])
                gateway.detach(clientId, ref)
            }
            await sleep(100)
            expect(internals._subscriptions.size).toBe(0)
        } finally {
            ws.close()
            await sleep(200)
        }
    })

    test('multiple clients on the same ref: ref stays until the LAST unsubscribes', async () => {
        const a = await wsStart(wsUrl, 'multi-a')
        const b = await wsStart(wsUrl, 'multi-b')
        try {
            gateway.listen([{ ref: 'shared', client_id: 'multi-a', gateway_id: gateway.id, listener_node_id: gateway.id }])
            gateway.listen([{ ref: 'shared', client_id: 'multi-b', gateway_id: gateway.id, listener_node_id: gateway.id }])
            await sleep(50)
            expect(internals._subscriptions.get('shared')?.size).toBe(2)

            gateway.detach('multi-a', 'shared')
            await sleep(50)
            expect(internals._subscriptions.get('shared')?.size).toBe(1) // ref still alive for b

            gateway.detach('multi-b', 'shared')
            await sleep(50)
            expect(internals._subscriptions.has('shared')).toBe(false)
        } finally {
            a.ws.close(); b.ws.close()
            await sleep(200)
        }
    })

    test('disconnect (no reconnect) cleans up subscriptions after the grace window', async () => {
        const clientId = 'lifecycle-disconnect'
        const { ws } = await wsStart(wsUrl, clientId)
        gateway.listen([{ ref: 'tasks', client_id: clientId, gateway_id: gateway.id, listener_node_id: gateway.id }])
        await sleep(50)
        expect(internals._subscriptions.get('tasks')?.has(clientId)).toBe(true)
        expect(internals._connections.has(clientId)).toBe(true)

        ws.close()
        // connection drops immediately; subscription removed after the 100ms grace
        await waitFor(() => !internals._connections.has(clientId), { label: 'connection removed', timeout: 2000 })
        await waitFor(() => !internals._subscriptions.has('tasks'), { label: 'subscription removed after grace', timeout: 2000 })
        expect(internals._pendingDisconnects.has(clientId)).toBe(false)
    })

    test('repeated connect/disconnect cycles do not leak connections or timers', async () => {
        for (let i = 0; i < 25; i++) {
            const clientId = `cycle-${i}`
            const { ws } = await wsStart(wsUrl, clientId)
            gateway.listen([{ ref: 'cyclic', client_id: clientId, gateway_id: gateway.id, listener_node_id: gateway.id }])
            ws.close()
            await sleep(20)
        }
        await waitFor(() => internals._connections.size === 0, { label: 'all connections gone', timeout: 4000 })
        await waitFor(() => internals._subscriptions.size === 0, { label: 'all subscriptions gone', timeout: 4000 })
        await waitFor(() => internals._pendingDisconnects.size === 0, { label: 'no dangling timers', timeout: 4000 })
    })
})
