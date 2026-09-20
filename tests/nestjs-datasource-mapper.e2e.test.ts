/**
 * E2E: the FULL @livequery/nestjs `createDatasourceMapper` pipeline with
 * @livequery/mongodb — decorator → LivequeryInterceptor (parse + WS subscribe)
 * → LivequeryDatasourceInterceptors → MongoDatasource.handle() (core engine
 * entry point), plus realtime via the `watcher: MongodbRealtime` plumbing.
 *
 * This is the path production apps use (querier/watcher class factories +
 * NestJS DI provider); the other nestjs suites wire datasource.handle()
 * manually and never touch this code.
 */

import '../nestjs/node_modules/reflect-metadata/Reflect.js'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as http from 'http'
import type { AddressInfo } from 'net'

import express from '../nestjs/node_modules/express/index.js'
import { Controller, Delete, Get, Module, Patch, Post } from '../nestjs/node_modules/@nestjs/common/index.js'
import { DiscoveryModule, NestFactory } from '../nestjs/node_modules/@nestjs/core/index.js'
import { ExpressAdapter } from '../nestjs/node_modules/@nestjs/platform-express/index.js'

// IMPORTANT: WebsocketGateway must come from the SAME copy of @livequery/core that
// nestjs/src resolves (nestjs/node_modules), so the DI token used by the provider's
// `inject: [..., WebsocketGateway]` and LivequeryInterceptor's @Inject matches.
import { WebsocketGateway, WEBSOCKET_PATH } from '../nestjs/node_modules/@livequery/core/build/src/node.js'
import { ObjectId } from '../mongodb/node_modules/mongodb/lib/index.js'

import { createDatasourceMapper } from '../nestjs/src/helpers/createDatasourceMapper.js'
import { LivequeryDatasourceInterceptors } from '../nestjs/src/LivequeryDatasourceInterceptors.js'
import { MongoDatasource, MongodbRealtime, type RouteOptions } from '../mongodb/src/index.js'

import { DB_NAME } from './helpers/env.js'
import { connectMongo, prepareCollection, uniqueCollection } from './helpers/mongo.js'
import { warmupRealtime } from './helpers/realtime.js'
import { sleep } from './helpers/wait.js'
import { closeServer, fetchJson, waitForWsMessage, wsStart } from './helpers/ws.js'

const COLLECTION = uniqueCollection('nest_mapper')
const REF = 'mappertasks'

function applyMethodDecorator(decorator: MethodDecorator, target: object, key: string) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key)
    if (!descriptor) throw new Error(`Missing method descriptor for ${key}`)
    decorator(target, key, descriptor)
}

describe('NestJS createDatasourceMapper + MongoDatasource + MongodbRealtime e2e', () => {
    let server: http.Server
    let gateway: InstanceType<typeof WebsocketGateway>
    let nestApp: any
    let mongoHandle: Awaited<ReturnType<typeof connectMongo>>
    let collection: any
    let apiUrl: string
    let wsUrl: string
    // Captured so afterAll can tear down the change stream (the provider keeps the
    // subscription internal; without this, retry() would spin after mongo.close()).
    let realtimeSub: { unsubscribe(): void } | undefined

    beforeAll(async () => {
        mongoHandle = await connectMongo()
        collection = await prepareCollection(mongoHandle.db, COLLECTION)

        server = http.createServer()
        gateway = new WebsocketGateway(server)

        // Passthrough subclass that only captures the watch subscription for cleanup.
        class ClosableRealtime extends MongodbRealtime {
            watch(config: any, routes: any) {
                const source = super.watch(config, routes)
                return {
                    subscribe: (observer: any) => {
                        realtimeSub = source.subscribe(observer)
                        return realtimeSub
                    },
                } as any
            }
        }

        const [useMongo, MongoProvider] = createDatasourceMapper({
            querier: MongoDatasource,
            watcher: ClosableRealtime,
            config: {
                connections: { default: mongoHandle.client },
                databases: [DB_NAME],
            },
        })
        const routeOptions: RouteOptions = { collection: COLLECTION, db: DB_NAME, realtime: true }

        class MapperTaskController {
            list() { }
            get() { }
            post() { }
            patch() { }
            del() { }
        }
        Controller(`livequery/${REF}`)(MapperTaskController)
        for (const [name, route] of [
            ['list', Get()],
            ['get', Get(':id')],
            ['post', Post()],
            ['patch', Patch(':id')],
            ['del', Delete(':id')],
        ] as Array<[string, MethodDecorator]>) {
            applyMethodDecorator(route, MapperTaskController.prototype, name)
            applyMethodDecorator(useMongo(routeOptions) as MethodDecorator, MapperTaskController.prototype, name)
        }

        class TestModule { }
        Module({
            imports: [DiscoveryModule],
            controllers: [MapperTaskController],
            providers: [
                MongoProvider as any,
                LivequeryDatasourceInterceptors,
                { provide: WebsocketGateway, useValue: gateway },
            ],
        })(TestModule)

        const expressApp = express()
        expressApp.use(express.json())
        nestApp = await NestFactory.create(TestModule, new ExpressAdapter(expressApp), {
            bodyParser: false,
            logger: false,
            // Without this, a bootstrap error makes Nest process.exit(1) silently
            // (logger is off), killing the whole bun test run with no output.
            abortOnError: false,
        })
        await nestApp.init()
        server.on('request', expressApp)

        await new Promise<void>(resolve => server.listen(0, resolve))
        const port = (server.address() as AddressInfo).port
        apiUrl = `http://127.0.0.1:${port}/livequery`
        wsUrl = `ws://127.0.0.1:${port}${WEBSOCKET_PATH}`

        await warmupRealtime({ apiUrl, wsUrl, collection } as any, REF)
    }, 60000)

    afterAll(async () => {
        realtimeSub?.unsubscribe()
        await nestApp?.close().catch(() => undefined)
        gateway?.close()
        if (server) await closeServer(server)
        await collection?.deleteMany({}).catch(() => undefined)
        await mongoHandle?.close()
    }, 30000)

    async function subscribe(clientId: string) {
        const { ws, gatewayId } = await wsStart(wsUrl, clientId)
        const res = await fetchJson(`${apiUrl}/${REF}`, {
            headers: { 'x-lcid': clientId, 'x-lgid': gatewayId },
        })
        expect(res.status).toBe(200)
        await sleep(100)
        return { ws, gatewayId }
    }

    // ── CRUD through decorator → interceptors → MongoDatasource.handle() ────────

    test('GET collection returns items with paging, private fields hidden', async () => {
        await collection.insertOne({ title: 'seed', done: false, _secret: 'hidden', seq: 1 })
        const { status, body } = await fetchJson(`${apiUrl}/${REF}`)
        expect(status).toBe(200)
        expect(Array.isArray(body.items)).toBe(true)

        const seed = body.items.find((i: any) => i.title === 'seed')
        expect(seed.id).toBeString()
        expect(seed._secret).toBeUndefined()
        expect(seed._id).toBeUndefined()
        expect(body.count.current).toBeGreaterThanOrEqual(1)
        expect(body.has).toBeDefined()
    })

    test('POST creates a document and returns the item (201)', async () => {
        const { status, body } = await fetchJson(`${apiUrl}/${REF}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'created', done: false, seq: 2 }),
        })
        expect(status).toBe(201)
        expect(body.item.id).toBeString()
        expect(body.item.title).toBe('created')

        const stored = await collection.findOne({ _id: ObjectId.createFromHexString(body.item.id) })
        expect(stored?.title).toBe('created')
    })

    test('GET document by id returns the item', async () => {
        const inserted = await collection.insertOne({ title: 'doc-get', seq: 3 })
        const id = inserted.insertedId.toString()
        const { status, body } = await fetchJson(`${apiUrl}/${REF}/${id}`)
        expect(status).toBe(200)
        expect(body.item).toMatchObject({ id, title: 'doc-get' })
    })

    test('PATCH applies $set semantics', async () => {
        const inserted = await collection.insertOne({ title: 'patch-me', done: false })
        const id = inserted.insertedId.toString()
        const { status, body } = await fetchJson(`${apiUrl}/${REF}/${id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ done: true }),
        })
        expect(status).toBe(200)
        expect(body.item).toMatchObject({ id, done: true })

        const stored = await collection.findOne({ _id: inserted.insertedId })
        expect(stored?.done).toBe(true)
        expect(stored?.title).toBe('patch-me')
    })

    test('DELETE removes the document', async () => {
        const inserted = await collection.insertOne({ title: 'temp' })
        const id = inserted.insertedId.toString()
        const { status } = await fetchJson(`${apiUrl}/${REF}/${id}`, { method: 'DELETE' })
        expect(status).toBe(200)
        expect(await collection.findOne({ _id: inserted.insertedId })).toBeNull()
    })

    test('filters and sort flow through the parsed query', async () => {
        await collection.insertMany([
            { title: 'f-1', seq: 10, done: false },
            { title: 'f-2', seq: 20, done: false },
        ])
        const { body } = await fetchJson(`${apiUrl}/${REF}?seq:gte=10&seq:sort=desc`)
        const seqs = body.items.map((i: any) => i.seq)
        expect(seqs.length).toBeGreaterThanOrEqual(2)
        expect([...seqs].sort((x: number, y: number) => y - x)).toEqual(seqs)
        expect(seqs.every((s: number) => s >= 10)).toBe(true)
    })

    // ── Realtime through the `watcher` plumbing of createDatasourceMapper ──────

    test('POST through the API reaches a subscribed WS client as added', async () => {
        const { ws } = await subscribe('mapper-rt-post')
        try {
            const syncP = waitForWsMessage<any>(ws, m =>
                m.event === 'sync' && m.data.changes.some((c: any) => c.type === 'added' && c.data?.title === 'rt-via-api'))
            const { status } = await fetchJson(`${apiUrl}/${REF}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ title: 'rt-via-api', done: false }),
            })
            expect(status).toBe(201)

            const sync = await syncP
            const change = sync.data.changes.find((c: any) => c.data?.title === 'rt-via-api')
            expect(change.ref).toBe(REF)
            expect(change.type).toBe('added')
            expect(change.data.id).toBeString()
        } finally {
            ws.close()
        }
    })

    test('out-of-band mongo update emits modified with changed fields', async () => {
        const inserted = await collection.insertOne({ title: 'before', done: false, version: 1 })
        const id = inserted.insertedId.toString()
        const { ws } = await subscribe('mapper-rt-modified')
        try {
            const syncP = waitForWsMessage<any>(ws, m =>
                m.event === 'sync' && m.data.changes.some((c: any) => c.data?.id === id && c.type === 'modified'))
            await collection.updateOne({ _id: inserted.insertedId }, { $set: { title: 'after', version: 2 } })

            const sync = await syncP
            const change = sync.data.changes.find((c: any) => c.data?.id === id)
            expect(change.data.title).toBe('after')
            expect(change.data.version).toBe(2)
        } finally {
            ws.close()
        }
    })
})
