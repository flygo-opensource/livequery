/**
 * E2E: nested-ref realtime fan-out with real MongoDB change streams.
 *
 * Route schema 'users/:userId/posts' — MongodbRealtime reads the `userId` field of
 * each changed document to build per-parent refs (convention: param name == field
 * name). Array fields fan out to one ref per element with membership added/removed.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as http from 'http'
import type { AddressInfo } from 'net'
import { WebsocketGateway, WEBSOCKET_PATH } from '../core/build/src/node.js'
import { MongodbRealtime } from '../mongodb/src/index.js'
import { connectMongo, prepareCollection, uniqueCollection, type MongoHandle } from './helpers/mongo.js'
import { DB_NAME } from './helpers/env.js'
import { sleep } from './helpers/wait.js'
import { waitForWsMessage, wsStart } from './helpers/ws.js'

const COLLECTION = uniqueCollection('nested_ref')

describe('Nested-ref realtime fan-out e2e', () => {
    let server: http.Server
    let gateway: WebsocketGateway
    let mongo: MongoHandle
    let collection: Awaited<ReturnType<typeof prepareCollection>>
    let realtime: ReturnType<MongodbRealtime['watch']> extends infer _ ? any : never
    let wsUrl: string

    beforeAll(async () => {
        mongo = await connectMongo()
        collection = await prepareCollection(mongo.db, COLLECTION)

        server = http.createServer()
        gateway = new WebsocketGateway(server)
        await new Promise<void>(resolve => server.listen(0, resolve))
        wsUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${WEBSOCKET_PATH}`

        realtime = new MongodbRealtime()
            .watch(
                { connections: { default: mongo.client }, databases: [DB_NAME] },
                [{
                    schema: 'users/:userId/posts',
                    options: { collection: COLLECTION, db: DB_NAME, realtime: true },
                }, {
                    schema: 'groups/:groupIds/posts',
                    options: { collection: COLLECTION, db: DB_NAME, realtime: true },
                }],
            )
            .subscribe(update => gateway.next(update as any))

        // warm up the change stream with a probe subscriber
        const probe = await subscribe('warmup', 'users/uw/posts')
        let ready = false
        probe.addEventListener('message', (e: MessageEvent) => {
            try { if (JSON.parse(e.data).event === 'sync') ready = true } catch { /* noop */ }
        })
        const started = Date.now()
        while (!ready && Date.now() - started < 20000) {
            await collection.insertOne({ userId: 'uw', __warmup: true })
            await sleep(300)
        }
        probe.close()
        if (!ready) throw new Error('Realtime change stream never became ready')
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

    async function subscribe(clientId: string, ref: string) {
        const { ws } = await wsStart(wsUrl, clientId)
        gateway.listen([{ ref, client_id: clientId, gateway_id: gateway.id, listener_node_id: gateway.id }])
        await sleep(50)
        return ws
    }

    test('insert fans out to the parent ref derived from the userId field', async () => {
        const wsU1 = await subscribe('nested-u1', 'users/u1/posts')
        const wsU2 = await subscribe('nested-u2', 'users/u2/posts')
        try {
            let u2got = false
            wsU2.addEventListener('message', (e: MessageEvent) => {
                try { if (JSON.parse(e.data).event === 'sync') u2got = true } catch { /* noop */ }
            })

            const syncP = waitForWsMessage<any>(wsU1, m =>
                m.event === 'sync' && m.data.changes.some((c: any) => c.data?.title === 'post-of-u1'))
            await collection.insertOne({ userId: 'u1', title: 'post-of-u1' })

            const sync = await syncP
            const change = sync.data.changes.find((c: any) => c.data?.title === 'post-of-u1')
            expect(change.ref).toBe('users/u1/posts')
            expect(change.type).toBe('added')

            await sleep(400)
            expect(u2got).toBe(false)
        } finally {
            wsU1.close()
            wsU2.close()
        }
    })

    test('array field membership change fans out added/removed per parent', async () => {
        const inserted = await collection.insertOne({ groupIds: ['g1', 'g2'], title: 'shared-post' })
        const id = inserted.insertedId.toString()
        await sleep(300)

        const wsG1 = await subscribe('nested-g1', 'groups/g1/posts')
        const wsG3 = await subscribe('nested-g3', 'groups/g3/posts')
        try {
            const removedP = waitForWsMessage<any>(wsG1, m =>
                m.event === 'sync' && m.data.changes.some((c: any) => c.data?.id === id && c.type === 'removed'))
            const addedP = waitForWsMessage<any>(wsG3, m =>
                m.event === 'sync' && m.data.changes.some((c: any) => c.data?.id === id && c.type === 'added'))

            // g1 leaves, g3 joins
            await collection.updateOne({ _id: inserted.insertedId }, { $set: { groupIds: ['g2', 'g3'] } })

            const removed = await removedP
            expect(removed.data.changes.find((c: any) => c.data?.id === id).ref).toBe('groups/g1/posts')

            const added = await addedP
            expect(added.data.changes.find((c: any) => c.data?.id === id).ref).toBe('groups/g3/posts')
        } finally {
            wsG1.close()
            wsG3.close()
        }
    })
})
