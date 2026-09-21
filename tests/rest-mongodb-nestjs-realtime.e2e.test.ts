import 'reflect-metadata'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as http from 'http'
import type { AddressInfo } from 'net'
import type { Subscription } from 'rxjs'
import express from 'express'
import { MongoClient, type Db, type Collection } from 'mongodb'
import { Controller, Get, Module, Req } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { ExpressAdapter } from '@nestjs/platform-express'
import { WebsocketGateway, WEBSOCKET_PATH } from '@livequery/core/node'
import { LivequeryInterceptor, UseLivequeryInterceptor } from '../packages/nestjs/src/LivequeryInterceptor.js'
import { MongoDatasource, MongodbRealtime } from '../packages/mongodb/src/index.js'
import { RestTransporter } from '../packages/rest/src/RestTransporter.js'

// This mirrors rest-mongoose-nestjs-realtime.e2e.test.ts but swaps the datasource
// implementation: MongoDatasource (native driver) instead of MongooseDatasource, and
// MongodbRealtime.watch() instead of a hand-rolled change stream. The NestJS wiring
// (interceptor + gateway + REST transporter) is identical, proving the adapter layer is
// datasource-agnostic.

type Task = {
    id: string
    taskId: string
    title: string
    done: boolean
    version: number
}

const MONGO_URL = process.env.LIVEQUERY_E2E_MONGO_URL
    ?? 'mongodb://127.0.0.1:27017'
const DB_NAME = process.env.LIVEQUERY_E2E_DB_NAME ?? 'livequery'
const COLLECTION = `rest_mongodb_nestjs_realtime_${Date.now()}`

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function applyMethodDecorator(
    decorator: MethodDecorator,
    target: object,
    key: string,
) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key)
    if (!descriptor) throw new Error(`Missing method descriptor for ${key}`)
    decorator(target, key, descriptor)
}

function closeServer(server: http.Server): Promise<void> {
    return new Promise(resolve => {
        try { server.closeAllConnections?.() } catch { }
        server.close(() => resolve())
    })
}

function waitForQueryEvent<T>(
    events: Array<Partial<T>>,
    predicate: (event: Partial<T>) => boolean,
    timeout = 8000,
): Promise<Partial<T>> {
    const existing = events.find(predicate)
    if (existing) return Promise.resolve(existing)

    return new Promise((resolve, reject) => {
        const started = Date.now()
        const timer = setInterval(() => {
            const event = events.find(predicate)
            if (event) {
                clearInterval(timer)
                resolve(event)
                return
            }
            if (Date.now() - started > timeout) {
                clearInterval(timer)
                reject(new Error('Timed out waiting for query event'))
            }
        }, 25)
    })
}

describe('REST + MongoDB (native) + core + NestJS realtime e2e', () => {
    let client: MongoClient
    let db: Db
    let collection: Collection<any>
    let datasource: MongoDatasource
    let realtimeSubscription: Subscription
    let app: any
    let server: http.Server
    let gateway: WebsocketGateway
    let transporter: RestTransporter
    let seedId: string
    let seedTaskId: string
    const emittedUpdates: any[] = []
    const registeredSubscriptions: any[] = []
    const seenHeaders: any[] = []

    beforeAll(async () => {
        client = new MongoClient(MONGO_URL, {
            authSource: process.env.LIVEQUERY_E2E_AUTH_SOURCE ?? 'admin',
            serverSelectionTimeoutMS: 15000,
        })
        await client.connect()
        db = client.db(DB_NAME)
        await db.createCollection(COLLECTION).catch(() => undefined)
        collection = db.collection(COLLECTION)
        await collection.deleteMany({})

        seedTaskId = `task-${Date.now()}`
        const seed = await collection.insertOne({
            taskId: seedTaskId,
            title: 'before-change',
            done: false,
            version: 1,
        })
        seedId = seed.insertedId.toString()

        datasource = new MongoDatasource({
            connections: { default: client },
            databases: [DB_NAME],
        })
        await datasource.init([
            {
                method: 'GET',
                path: '/livequery/tasks',
                collection: COLLECTION,
                db: DB_NAME,
                realtime: true,
            },
            {
                method: 'GET',
                path: '/livequery/tasks/:taskId',
                collection: COLLECTION,
                db: DB_NAME,
            },
        ])

        server = http.createServer()
        gateway = new WebsocketGateway(server)
        const listen = gateway.listen.bind(gateway)
        gateway.listen = ((events: any[]) => {
            registeredSubscriptions.push(...events)
            return listen(events)
        }) as typeof gateway.listen

        // Drive realtime updates straight from MongodbRealtime.watch() — the same engine
        // honojs/nestjs adapters wire to the gateway. Pre/post images disabled so the test
        // does not require collMod privileges; modified events still carry changed fields.
        realtimeSubscription = new MongodbRealtime({ enablePreAndPostImages: false })
            .watch(
                { connections: { default: client }, databases: [DB_NAME] },
                [{ schema: 'tasks', options: { collection: COLLECTION, db: DB_NAME, realtime: true } }],
            )
            .subscribe(update => {
                emittedUpdates.push(update)
                gateway.next(update as any)
            })
        await sleep(1000)

        const runDatasource = async (req: any, routeRef: string) => {
            seenHeaders.push(req.headers)
            const ctx = {
                request: {
                    path: req.originalUrl ?? req.url ?? '',
                    ref: routeRef,
                    params: req.params ?? {},
                    query: req.query ?? {},
                    body: req.body,
                    method: req.method,
                    headers: new Headers(req.headers as HeadersInit) as any,
                },
                livequery: req.livequery,
            }
            // The NestJS interceptor parses req.livequery; this explicit core call
            // registers the REST client's socket subscription in this manual test app.
            if (req.method === 'GET') gateway.handle(ctx as any)
            return await datasource.handle(ctx as any)
        }

        class TaskController {
            async list(req: any) {
                return { data: await runDatasource(req, '/livequery/tasks') }
            }

            async get(req: any) {
                return { data: await runDatasource(req, '/livequery/tasks/:taskId') }
            }
        }

        Controller('livequery/tasks')(TaskController)
        Req()(TaskController.prototype, 'list', 0)
        applyMethodDecorator(Get(), TaskController.prototype, 'list')
        applyMethodDecorator(UseLivequeryInterceptor(), TaskController.prototype, 'list')
        Req()(TaskController.prototype, 'get', 0)
        applyMethodDecorator(Get(':taskId'), TaskController.prototype, 'get')
        applyMethodDecorator(UseLivequeryInterceptor(), TaskController.prototype, 'get')

        class TestModule { }
        Module({
            controllers: [TaskController],
            providers: [
                { provide: LivequeryInterceptor, useFactory: () => new LivequeryInterceptor(gateway) },
                { provide: WebsocketGateway, useValue: gateway },
            ],
        })(TestModule)

        const expressApp = express()
        app = await NestFactory.create(TestModule, new ExpressAdapter(expressApp), {
            bodyParser: false,
            logger: false,
        })
        await app.init()
        server.on('request', expressApp)
        await new Promise<void>(resolve => server.listen(0, resolve))

        const port = (server.address() as AddressInfo).port
        transporter = new RestTransporter({
            api: `http://127.0.0.1:${port}/livequery`,
            ws: `ws://127.0.0.1:${port}${WEBSOCKET_PATH}`,
        })
    }, 60000)

    afterAll(async () => {
        ; (transporter as any)?.socket?.stop?.()
        realtimeSubscription?.unsubscribe()
        await app?.close?.()
        gateway?.close()
        if (server) await closeServer(server)
        await collection?.deleteMany({}).catch(() => undefined)
        await client?.close().catch(() => undefined)
    }, 60000)

    test('emits a native MongoDB field update to a REST realtime client', async () => {
        const ref = 'tasks'
        const events: any[] = []
        const subscription = transporter.query<Task>({
            ref,
            filters: { ':limit': 10 },
        }).subscribe(event => {
            events.push(event)
        })

        try {
            const initial = await waitForQueryEvent(events, event => event.source === 'query')
            expect(Array.isArray(initial.changes), JSON.stringify(initial)).toBe(true)
            expect(initial.changes).toContainEqual(expect.objectContaining({
                id: seedId,
                type: 'added',
                data: expect.objectContaining({
                    id: seedId,
                    taskId: seedTaskId,
                    title: 'before-change',
                }),
            }))
            expect(registeredSubscriptions, JSON.stringify(seenHeaders)).toContainEqual(expect.objectContaining({
                ref,
                gateway_id: gateway.id,
            }))

            await sleep(500)
            await collection.updateOne(
                { taskId: seedTaskId },
                { $set: { title: 'after-change', version: 2 } },
            )
            await waitForQueryEvent(emittedUpdates, update => (
                update.ref === ref
                && update.type === 'modified'
                && update.data?.id === seedId
                && update.data?.title === 'after-change'
            ))

            const realtime = await waitForQueryEvent(events, event => (
                event.source === 'realtime'
                && event.changes?.some((change: any) => (
                    change.id === seedId
                    && change.type === 'modified'
                    && change.ref === ref
                    && change.data?.title === 'after-change'
                    && change.data?.version === 2
                ))
            ))

            expect(realtime.changes?.[0]).toMatchObject({
                id: seedId,
                ref,
                type: 'modified',
                collection_ref: 'tasks',
                data: {
                    id: seedId,
                    title: 'after-change',
                    version: 2,
                },
            })
        } finally {
            subscription.unsubscribe()
        }
    }, 20000)
})
