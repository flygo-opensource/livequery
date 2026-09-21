/**
 * E2E: no-loss delivery under burst load across a 1-service / 2-gateway topology.
 *
 * Topology (mirrors a real deployment where the data service is separate from the
 * websocket-facing API gateways):
 *
 *        client A ─ws─►  gw1 ─bridge─►┐
 *                                     ├─►  service   (emits N events via gateway.next)
 *        client B ─ws─►  gw2 ─bridge─►┘
 *
 *   - `service` is the single node that owns the data and emits updates.
 *   - `gw1` / `gw2` are two independent API-gateway nodes. Each opens a gateway
 *     bridge to `service` (gateway.connect) exactly like a hono/nest API process does.
 *   - A WS client connects to a gateway; its subscription is registered ON the
 *     service (x-lgid = that gateway's id), so emits route service → gw → client.
 *
 * The question under test: if the service emits 100 events back-to-back, does every
 * subscribed client receive all 100 (no drops, no dupes that hide a drop)? TCP +
 * the RxJS Subject fan-out should guarantee it; this proves it end-to-end through
 * the cross-gateway bridge under both single- and split-client fan-out.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as http from 'http'
import type { AddressInfo } from 'net'
import { WebsocketGateway, WEBSOCKET_PATH } from '../packages/core/build/src/node.js'
import { sleep, waitFor } from './helpers/wait.js'
import { wsStart } from './helpers/ws.js'

const REF = 'tasks'
const TOTAL = 100

type Node = { server: http.Server, gateway: WebsocketGateway, port: number, wsUrl: string }

async function startNode(): Promise<Node> {
    const server = http.createServer()
    const gateway = new WebsocketGateway(server)
    await new Promise<void>(resolve => server.listen(0, resolve))
    const port = (server.address() as AddressInfo).port
    return { server, gateway, port, wsUrl: `ws://127.0.0.1:${port}${WEBSOCKET_PATH}` }
}

function closeNode(node: Node): Promise<void> {
    node.gateway.close()
    return new Promise<void>(resolve => {
        try { (node.server as any).closeAllConnections?.() } catch { /* noop */ }
        node.server.close(() => resolve())
    })
}

/** Accumulate the `seq` of every sync change frame this client receives. */
function collectSeqs(ws: WebSocket) {
    const seqs: number[] = []
    ws.addEventListener('message', (e: MessageEvent) => {
        try {
            const m = JSON.parse(e.data)
            if (m.event !== 'sync') return
            for (const c of m.data.changes) {
                if (typeof c.data?.seq === 'number') seqs.push(c.data.seq)
            }
        } catch { /* ignore non-JSON / non-sync frames */ }
    })
    return seqs
}

/** Set of 0..TOTAL-1 that are missing from `seqs`. */
function missing(seqs: number[]): number[] {
    const present = new Set(seqs)
    return Array.from({ length: TOTAL }, (_, i) => i).filter(i => !present.has(i))
}

describe('Burst delivery across 1 service + 2 gateways (no event loss)', () => {
    let service: Node
    let gw1: Node
    let gw2: Node
    let bridge1: { unsubscribe(): void }
    let bridge2: { unsubscribe(): void }

    beforeAll(async () => {
        service = await startNode()
        gw1 = await startNode()
        gw2 = await startNode()

        // Each gateway bridges UP to the service, just like an API process would.
        bridge1 = gw1.gateway.connect(service.wsUrl, service.gateway.auth)
        bridge2 = gw2.gateway.connect(service.wsUrl, service.gateway.auth)
        await sleep(400) // let both gateway handshakes settle
    }, 30000)

    afterAll(async () => {
        bridge1?.unsubscribe()
        bridge2?.unsubscribe()
        await Promise.all([closeNode(gw1), closeNode(gw2), closeNode(service)])
    }, 30000)

    /** Connect a client to `gw`, then register its subscription ON the service. */
    async function subscribeVia(gw: Node, clientId: string) {
        const { ws } = await wsStart(gw.wsUrl, clientId)
        // What an API process does on GET with x-lcid/x-lgid: register on the
        // node that owns the data (service), pointing back to the client's gateway.
        service.gateway.listen([{
            ref: REF,
            client_id: clientId,
            gateway_id: gw.gateway.id,
            listener_node_id: service.gateway.id,
        }])
        await sleep(200) // let the subscribe hop reach the gateway
        return ws
    }

    test('single client on gw1 receives all 100 burst-emitted events', async () => {
        const ws = await subscribeVia(gw1, 'burst-single')
        const seqs = collectSeqs(ws)
        try {
            // Fire 100 events back-to-back, no awaits between them.
            for (let i = 0; i < TOTAL; i++) {
                service.gateway.next({ ref: REF, type: 'added', data: { id: `evt-${i}`, seq: i } } as any)
            }

            await waitFor(() => seqs.length >= TOTAL || undefined, { timeout: 15000, label: 'all 100 events' })

            expect(seqs.length).toBe(TOTAL)
            expect(missing(seqs)).toEqual([])
            // Delivery order must be preserved across the bridge.
            expect(seqs).toEqual(Array.from({ length: TOTAL }, (_, i) => i))
        } finally {
            ws.close()
        }
    }, 30000)

    test('two clients split across gw1 and gw2 each receive all 100', async () => {
        const wsA = await subscribeVia(gw1, 'burst-a')
        const wsB = await subscribeVia(gw2, 'burst-b')
        const seqsA = collectSeqs(wsA)
        const seqsB = collectSeqs(wsB)
        try {
            for (let i = 0; i < TOTAL; i++) {
                service.gateway.next({ ref: REF, type: 'added', data: { id: `split-${i}`, seq: i } } as any)
            }

            await waitFor(() => (seqsA.length >= TOTAL && seqsB.length >= TOTAL) || undefined,
                { timeout: 15000, label: 'both clients get 100' })

            expect(seqsA.length).toBe(TOTAL)
            expect(seqsB.length).toBe(TOTAL)
            expect(missing(seqsA)).toEqual([])
            expect(missing(seqsB)).toEqual([])
            expect(seqsA).toEqual(Array.from({ length: TOTAL }, (_, i) => i))
            expect(seqsB).toEqual(Array.from({ length: TOTAL }, (_, i) => i))
        } finally {
            wsA.close()
            wsB.close()
        }
    }, 30000)
})
