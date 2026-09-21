/**
 * E2E: a COMPLETE NestJS app built with @livequery/nestjs (createDatasourceMapper)
 * + @livequery/mongodb (MongoDatasource + MongodbRealtime), exercised end-to-end
 * through @livequery/rest's RestTransporter — the exact stack a production
 * frontend talks to:
 *
 *   RestTransporter (HTTP + WS, x-lcid/x-lgid headers)
 *     → NestJS controller (decorator from createDatasourceMapper)
 *       → LivequeryInterceptor → LivequeryDatasourceInterceptors
 *         → MongoDatasource.handle() → real MongoDB (replica set)
 *     ← realtime: change streams → MongodbRealtime → WebsocketGateway → socket
 *
 * Full CRUD (add/get/query/update/delete) + realtime add/modify/remove events.
 */

import 'reflect-metadata'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as http from 'http'
import type { AddressInfo } from 'net'

import express from 'express'
import { Controller, Delete, Get, Module, Patch, Post } from '@nestjs/common'
import { DiscoveryModule, NestFactory } from '@nestjs/core'
import { ExpressAdapter } from '@nestjs/platform-express'

// Same copy of @livequery/core as nestjs/src resolves — DI token identity.
import { WebsocketGateway, WEBSOCKET_PATH } from '@livequery/core/node'
import { ObjectId } from 'mongodb'

import { createDatasourceMapper } from '../packages/nestjs/src/helpers/createDatasourceMapper.js'
import { LivequeryDatasourceInterceptors } from '../packages/nestjs/src/LivequeryDatasourceInterceptors.js'
import { MongoDatasource, MongodbRealtime, type RouteOptions } from '../packages/mongodb/src/index.js'
import { RestTransporter } from '../packages/rest/src/RestTransporter.js'

import { DB_NAME } from './helpers/env.js'
import { connectMongo, prepareCollection, uniqueCollection } from './helpers/mongo.js'
import { warmupRealtime } from './helpers/realtime.js'
import { sleep } from './helpers/wait.js'
import { closeServer } from './helpers/ws.js'

const COLLECTION = uniqueCollection('rest_mapper')
const REF = 'resttasks'

type Task = { id: string, title: string, done: boolean, seq: number, version?: number }

function applyMethodDecorator(decorator: MethodDecorator, target: object, key: string) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key)
    if (!descriptor) throw new Error(`Missing method descriptor for ${key}`)
    decorator(target, key, descriptor)
}

async function waitForEvent<T>(events: T[], predicate: (e: T) => boolean, label: string, timeout = 10000): Promise<T> {
    const started = Date.now()
    while (Date.now() - started < timeout) {
        const found = events.find(predicate)
        if (found) return found
        await sleep(50)
    }
    throw new Error(`Timeout waiting for ${label}: ${JSON.stringify(events.slice(-3))}`)
}

describe('RestTransporter → NestJS (createDatasourceMapper) → MongoDatasource fullstack e2e', () => {
    let server: http.Server
    let gateway: InstanceType<typeof WebsocketGateway>
    let nestApp: any
    let mongoHandle: Awaited<ReturnType<typeof connectMongo>>
    let collection: any
    let transporter: RestTransporter
    let realtimeSub: { unsubscribe(): void } | undefined

    beforeAll(async () => {
        mongoHandle = await connectMongo()
        collection = await prepareCollection(mongoHandle.db, COLLECTION)

        server = http.createServer()
        gateway = new WebsocketGateway(server)

        // Passthrough subclass capturing the watch subscription for clean teardown.
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

        class RestTaskController {
            list() { }
            get() { }
            post() { }
            patch() { }
            del() { }
        }
        Controller(`livequery/${REF}`)(RestTaskController)
        for (const [name, route] of [
            ['list', Get()],
            ['get', Get(':id')],
            ['post', Post()],
            ['patch', Patch(':id')],
            ['del', Delete(':id')],
        ] as Array<[string, MethodDecorator]>) {
            applyMethodDecorator(route, RestTaskController.prototype, name)
            applyMethodDecorator(useMongo(routeOptions) as MethodDecorator, RestTaskController.prototype, name)
        }

        class TestModule { }
        Module({
            imports: [DiscoveryModule],
            controllers: [RestTaskController],
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
            abortOnError: false,
        })
        await nestApp.init()
        server.on('request', expressApp)

        await new Promise<void>(resolve => server.listen(0, resolve))
        const port = (server.address() as AddressInfo).port
        const apiUrl = `http://127.0.0.1:${port}/livequery`
        const wsUrl = `ws://127.0.0.1:${port}${WEBSOCKET_PATH}`

        await warmupRealtime({ apiUrl, wsUrl, collection } as any, REF)

        transporter = new RestTransporter({ api: apiUrl, ws: wsUrl })
    }, 60000)

    afterAll(async () => {
        ;(transporter as any)?.socket?.stop?.()
        realtimeSub?.unsubscribe()
        await nestApp?.close().catch(() => undefined)
        gateway?.close()
        if (server) await closeServer(server)
        await collection?.deleteMany({}).catch(() => undefined)
        await mongoHandle?.close()
    }, 30000)

    test('query() returns the initial snapshot with paging', async () => {
        await collection.insertMany([
            { title: 'snap-1', done: false, seq: 1, _secret: 'hidden' },
            { title: 'snap-2', done: true, seq: 2 },
        ])

        const events: any[] = []
        const sub = transporter.query<Task>({ ref: REF, filters: { ':limit': 50 } as any }).subscribe(e => events.push(e))
        try {
            const snapshot = await waitForEvent(events, e => e.source === 'query', 'initial snapshot')
            const titles = snapshot.changes.map((c: any) => c.data.title)
            expect(titles).toContain('snap-1')
            expect(titles).toContain('snap-2')
            expect(snapshot.changes.every((c: any) => c.type === 'added')).toBe(true)
            // private fields are masked by LivequeryInterceptor
            const snap1 = snapshot.changes.find((c: any) => c.data.title === 'snap-1')
            expect(snap1.data._secret).toBeUndefined()
            expect(snapshot.paging.total).toBeGreaterThanOrEqual(2)
        } finally {
            sub.unsubscribe()
        }
    })

    test('add() creates a document and the realtime added event arrives', async () => {
        const events: any[] = []
        const sub = transporter.query<Task>({ ref: REF, filters: { ':limit': 50 } as any }).subscribe(e => events.push(e))
        try {
            await waitForEvent(events, e => e.source === 'query', 'snapshot before add')

            const created = await transporter.add<Task>(REF, { title: 'rest-created', done: false, seq: 10 })
            expect(created.id).toBeString()
            expect(created.title).toBe('rest-created')

            const stored = await collection.findOne({ _id: ObjectId.createFromHexString(created.id) })
            expect(stored?.title).toBe('rest-created')

            const realtime = await waitForEvent(events, e =>
                e.source === 'realtime' && e.changes?.some((c: any) => c.type === 'added' && c.data?.id === created.id),
                'realtime added')
            const change = realtime.changes.find((c: any) => c.data?.id === created.id)
            expect(change.ref).toBe(REF)
            expect(change.data.title).toBe('rest-created')
        } finally {
            sub.unsubscribe()
        }
    })

    test('update() patches the document and emits modified with changed fields', async () => {
        const inserted = await collection.insertOne({ title: 'to-update', done: false, seq: 20, version: 1 })
        const id = inserted.insertedId.toString()

        const events: any[] = []
        const sub = transporter.query<Task>({ ref: REF, filters: { ':limit': 50 } as any }).subscribe(e => events.push(e))
        try {
            await waitForEvent(events, e => e.source === 'query', 'snapshot before update')

            await transporter.update<Task>(REF, id, { title: 'updated-via-rest', version: 2 } as any)

            const stored = await collection.findOne({ _id: inserted.insertedId })
            expect(stored?.title).toBe('updated-via-rest')
            expect(stored?.done).toBe(false) // $set semantics — untouched fields survive

            const realtime = await waitForEvent(events, e =>
                e.source === 'realtime' && e.changes?.some((c: any) => c.type === 'modified' && c.data?.id === id),
                'realtime modified')
            const change = realtime.changes.find((c: any) => c.data?.id === id)
            expect(change.data.title).toBe('updated-via-rest')
            expect(change.data.version).toBe(2)
        } finally {
            sub.unsubscribe()
        }
    })

    test('delete() removes the document and emits removed', async () => {
        const inserted = await collection.insertOne({ title: 'to-delete', done: false, seq: 30 })
        const id = inserted.insertedId.toString()

        const events: any[] = []
        const sub = transporter.query<Task>({ ref: REF, filters: { ':limit': 50 } as any }).subscribe(e => events.push(e))
        try {
            await waitForEvent(events, e => e.source === 'query', 'snapshot before delete')

            await transporter.delete<Task>(REF, id)
            expect(await collection.findOne({ _id: inserted.insertedId })).toBeNull()

            const realtime = await waitForEvent(events, e =>
                e.source === 'realtime' && e.changes?.some((c: any) => c.type === 'removed' && c.data?.id === id),
                'realtime removed')
            const change = realtime.changes.find((c: any) => c.data?.id === id)
            expect(change.ref).toBe(REF)
        } finally {
            sub.unsubscribe()
        }
    })

    test('query() with filters and sort flows through to MongoQuery', async () => {
        await collection.insertMany([
            { title: 'q-low', done: false, seq: 100 },
            { title: 'q-mid', done: false, seq: 200 },
            { title: 'q-high', done: false, seq: 300 },
        ])

        const events: any[] = []
        const sub = transporter.query<Task>({
            ref: REF,
            filters: { 'seq:gte': 200, 'seq:sort': 'desc', ':limit': 10 } as any,
        }).subscribe(e => events.push(e))
        try {
            const snapshot = await waitForEvent(events, e => e.source === 'query', 'filtered snapshot')
            const seqs = snapshot.changes.map((c: any) => c.data.seq)
            expect(seqs.length).toBe(2)
            expect(seqs).toEqual([300, 200]) // desc order, gte filter applied
        } finally {
            sub.unsubscribe()
        }
    })

    test('out-of-band mongo write reaches the REST realtime client', async () => {
        const events: any[] = []
        const sub = transporter.query<Task>({ ref: REF, filters: { ':limit': 50 } as any }).subscribe(e => events.push(e))
        try {
            await waitForEvent(events, e => e.source === 'query', 'snapshot before oob write')

            const inserted = await collection.insertOne({ title: 'oob-insert', done: false, seq: 999 })
            const realtime = await waitForEvent(events, e =>
                e.source === 'realtime' && e.changes?.some((c: any) => c.type === 'added' && c.data?.title === 'oob-insert'),
                'realtime oob added')
            const change = realtime.changes.find((c: any) => c.data?.title === 'oob-insert')
            expect(change.data.id).toBe(inserted.insertedId.toString())
        } finally {
            sub.unsubscribe()
        }
    })
})
