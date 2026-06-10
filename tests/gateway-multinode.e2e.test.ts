/**
 * E2E: cross-gateway realtime routing with real MongoDB.
 *
 * Two WebsocketGateways on two HTTP servers. The LOCAL gateway bridges to the
 * REMOTE one (gateway.connect). A WS client connects to LOCAL; its subscription is
 * registered on REMOTE (x-lgid = local gateway id). MongodbRealtime feeds the
 * REMOTE gateway — sync events must route remote → local → client.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as http from 'http'
import type { AddressInfo } from 'net'
import { WebsocketGateway, WEBSOCKET_PATH } from '../core/build/src/index.js'
import { MongodbRealtime } from '../mongodb/src/index.js'
import { connectMongo, prepareCollection, uniqueCollection, type MongoHandle } from './helpers/mongo.js'
import { DB_NAME } from './helpers/env.js'
import { sleep } from './helpers/wait.js'
import { waitForWsMessage, wsStart } from './helpers/ws.js'

const COLLECTION = uniqueCollection('multinode')

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

describe('Multi-gateway realtime routing e2e', () => {
    let local: Node
    let remote: Node
    let bridge: { unsubscribe(): void }
    let mongo: MongoHandle
    let collection: Awaited<ReturnType<typeof prepareCollection>>
    let realtime: any

    beforeAll(async () => {
        mongo = await connectMongo()
        collection = await prepareCollection(mongo.db, COLLECTION)

        local = await startNode()
        remote = await startNode()
        bridge = local.gateway.connect(
            `ws://127.0.0.1:${remote.port}${WEBSOCKET_PATH}`,
            remote.gateway.auth,
        )
        await sleep(300) // let the gateway handshake settle

        // realtime feeds the REMOTE gateway only
        realtime = new MongodbRealtime()
            .watch(
                { connections: { default: mongo.client }, databases: [DB_NAME] },
                [{ schema: 'tasks', options: { collection: COLLECTION, db: DB_NAME, realtime: true } }],
            )
            .subscribe(update => remote.gateway.next(update as any))

        // warm up the change stream via a probe subscribed directly on REMOTE
        const probe = await wsStart(remote.wsUrl, 'warmup-remote')
        remote.gateway.listen([{ ref: 'tasks', client_id: 'warmup-remote', gateway_id: remote.gateway.id, listener_node_id: remote.gateway.id }])
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
        if (!ready) throw new Error('Realtime change stream never became ready')
        await collection.deleteMany({ __warmup: true })
        await sleep(500)
    }, 45000)

    afterAll(async () => {
        realtime?.unsubscribe?.()
        bridge?.unsubscribe()
        await Promise.all([closeNode(local), closeNode(remote)])
        await collection?.deleteMany({}).catch(() => undefined)
        await mongo?.close()
    }, 30000)

    test('a client on LOCAL receives mongo changes emitted at REMOTE', async () => {
        const clientId = 'cross-node-client'
        const { ws } = await wsStart(local.wsUrl, clientId)
        try {
            // Register the subscription on REMOTE, pointing back to the LOCAL gateway —
            // exactly what an API service does when it receives x-lcid/x-lgid headers.
            remote.gateway.handle({
                request: {
                    path: '/livequery/tasks',
                    ref: '/livequery/tasks',
                    method: 'GET',
                    body: undefined,
                    params: {},
                    query: {},
                    headers: new Map([
                        ['x-lcid', clientId],
                        ['x-lgid', local.gateway.id],
                    ]),
                },
                livequery: {
                    ref: 'tasks',
                    collection_ref: 'tasks',
                    schema_collection_ref: 'tasks',
                    document_id: undefined,
                    keys: {},
                    method: 'GET',
                    path: '/livequery/tasks',
                    query: {},
                    body: undefined,
                } as any,
            } as any)
            await sleep(200)

            const syncP = waitForWsMessage<any>(ws, m =>
                m.event === 'sync' && m.data.changes.some((c: any) => c.data?.title === 'cross-node'), 10000)

            await collection.insertOne({ title: 'cross-node', done: false })

            const sync = await syncP
            const change = sync.data.changes.find((c: any) => c.data?.title === 'cross-node')
            expect(change.ref).toBe('tasks')
            expect(change.type).toBe('added')
        } finally {
            ws.close()
        }
    })

    test('manual remote emission also routes across gateways', async () => {
        const clientId = 'cross-node-manual'
        const { ws } = await wsStart(local.wsUrl, clientId)
        try {
            remote.gateway.listen([{ ref: 'tasks', client_id: clientId, gateway_id: local.gateway.id, listener_node_id: remote.gateway.id }])
            await sleep(200)

            const syncP = waitForWsMessage<any>(ws, m =>
                m.event === 'sync' && m.data.changes.some((c: any) => c.data?.id === 'manual-cross'), 10000)

            remote.gateway.next({ ref: 'tasks', type: 'added', data: { id: 'manual-cross', title: 'hello' } } as any)

            const sync = await syncP
            expect(sync.data.changes[0].data.title).toBe('hello')
        } finally {
            ws.close()
        }
    })
})
