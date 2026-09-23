import 'reflect-metadata'

import * as http from 'http'
import type { AddressInfo } from 'net'
import type { Subscription } from 'rxjs'

import { Hono } from 'hono'
import express from 'express'
import { Controller, Delete, Get, Module, Patch, Post, Req } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { ExpressAdapter } from '@nestjs/platform-express'

import { WebsocketGateway, WEBSOCKET_PATH } from '../../packages/core/build/src/node.js'
import { nodeRequestToWebRequest } from '../../packages/core/build/src/helpers/nodeRequestToWebRequest.js'
import { writeWebResponse } from '../../packages/core/build/src/helpers/writeWebResponse.js'
import { createLivequery, createDatasourceMapper, getLivequeryRequest, livequeryJson, mapLivequeryResponse, validator, type LivequerySchema } from '../../packages/honojs/src/index.js'
import { LivequeryInterceptor, UseLivequeryInterceptor } from '../../packages/nestjs/src/LivequeryInterceptor.js'
import { MongoDatasource, MongodbRealtime, type RouteOptions } from '../../packages/mongodb/src/index.js'
import type { MongoClient, Db, Collection } from 'mongodb'

import { DB_NAME } from './env.js'
import { connectMongo, prepareCollection } from './mongo.js'

export type AppHandle = {
    port: number
    apiUrl: string          // http://127.0.0.1:{port}/livequery
    wsUrl: string           // ws://127.0.0.1:{port}{WEBSOCKET_PATH}
    server: http.Server
    gateway: WebsocketGateway
    datasource: MongoDatasource
    mongo: MongoClient
    db: Db
    collection: Collection<any>
    close(): Promise<void>
}

export type BuildAppOptions = {
    /** Physical mongo collection name (unique per suite). */
    collection: string
    /** URL ref segment, e.g. 'tasks' → routes /livequery/tasks[...]. Default 'tasks'. */
    ref?: string
    /** Wire MongodbRealtime.watch into the gateway. Default true. */
    realtime?: boolean
    /** Wrap responses in the `{ data }` envelope expected by RestTransporter. Default true. */
    wrapData?: boolean
    /**
     * Hono only: guard POST/PATCH with `validator(schema)`, as the shipped examples do. With a
     * `z.strictObject` any unknown key in a write body (a client `id`, say) answers 400.
     */
    schema?: LivequerySchema
}

function applyMethodDecorator(decorator: MethodDecorator, target: object, key: string) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key)
    if (!descriptor) throw new Error(`Missing method descriptor for ${key}`)
    decorator(target, key, descriptor)
}

function closeHttpServer(server: http.Server): Promise<void> {
    return new Promise(resolve => {
        try { (server as any).closeAllConnections?.() } catch { /* noop */ }
        server.close(() => resolve())
    })
}

function wireRealtime(gateway: WebsocketGateway, mongo: MongoClient, collection: string, schema: string): Subscription {
    return new MongodbRealtime()
        .watch(
            { connections: { default: mongo }, databases: [DB_NAME] },
            [{ schema, options: { collection, db: DB_NAME, realtime: true } }],
        )
        .subscribe(update => gateway.next(update as any))
}

// ─── Hono ────────────────────────────────────────────────────────────────────

export async function buildHonoMongoApp(options: BuildAppOptions): Promise<AppHandle> {
    const ref = options.ref ?? 'tasks'
    const wrapData = options.wrapData ?? true

    const { client: mongo, db } = await connectMongo()
    const collection = await prepareCollection(db, options.collection)

    const datasource = new MongoDatasource({
        connections: { default: mongo },
        databases: [DB_NAME],
    })

    const server = http.createServer()
    const gateway = new WebsocketGateway(server)

    const app = new Hono()
    const lq = createLivequery(app as any, { websocketGateway: gateway })

    const routeOptions: RouteOptions = { collection: options.collection, db: DB_NAME, realtime: true }
    const routes = [
        { method: 'GET', path: `livequery/${ref}`, options: routeOptions },
        { method: 'GET', path: `livequery/${ref}/:id`, options: routeOptions },
        { method: 'POST', path: `livequery/${ref}`, options: routeOptions },
        { method: 'PATCH', path: `livequery/${ref}/:id`, options: routeOptions },
        { method: 'DELETE', path: `livequery/${ref}/:id`, options: routeOptions },
    ]
    const useDatasource = await createDatasourceMapper({
        datasource: datasource as any,
        websocketGateway: gateway,
        routes,
        ...options.realtime !== false ? {
            watcher: new MongodbRealtime() as any,
            config: { connections: { default: mongo }, databases: [DB_NAME] },
        } : {},
    })

    // wrapData: REST clients (RestTransporter) expect the `{ data }` envelope, so wrap
    // the datasource result manually; otherwise expose useDatasource's native shape.
    const handler = (opts: RouteOptions) => wrapData
        ? async (c: any) => {
            const request = getLivequeryRequest(c)
            try {
                const result = await datasource.query(request as any, opts)
                return c.json({ data: mapLivequeryResponse(result as any) })
            } catch (e: any) {
                const status = typeof e?.status === 'number' ? e.status : 500
                return c.json({ error: { code: e?.code ?? 'INTERNAL', message: e?.message ?? 'error' } }, status)
            }
        }
        : useDatasource(opts as any)

    lq.get(`/livequery/${ref}`, handler(routeOptions))
    lq.get(`/livequery/${ref}/:id`, handler(routeOptions))
    const guard = options.schema ? [validator(options.schema)] : []
    lq.post(`/livequery/${ref}`, ...guard, handler(routeOptions))
    lq.patch(`/livequery/${ref}/:id`, ...guard, handler(routeOptions))
    lq.delete(`/livequery/${ref}/:id`, handler(routeOptions))

    // Bridge node http → hono fetch (gateway keeps the WS upgrade path on the same server)
    server.on('request', async (req, res) => {
        try {
            const chunks: Buffer[] = []
            for await (const chunk of req) chunks.push(chunk as Buffer)
            if (chunks.length) (req as any).rawBody = Buffer.concat(chunks)
            const response = await app.fetch(nodeRequestToWebRequest(req as any))
            await writeWebResponse(res, response)
        } catch (e: any) {
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: { code: 'BRIDGE_ERROR', message: e?.message } }))
        }
    })

    await new Promise<void>(resolve => server.listen(0, resolve))
    const port = (server.address() as AddressInfo).port

    return {
        port,
        apiUrl: `http://127.0.0.1:${port}/livequery`,
        wsUrl: `ws://127.0.0.1:${port}${WEBSOCKET_PATH}`,
        server,
        gateway,
        datasource,
        mongo,
        db,
        collection,
        close: async () => {
            useDatasource.realtime?.unsubscribe()
            gateway.close()
            await closeHttpServer(server)
            await collection.deleteMany({}).catch(() => undefined)
            await mongo.close().catch(() => undefined)
        },
    }
}

// ─── NestJS ──────────────────────────────────────────────────────────────────

export async function buildNestMongoApp(options: BuildAppOptions): Promise<AppHandle & { nestApp: any }> {
    const ref = options.ref ?? 'tasks'

    const { client: mongo, db } = await connectMongo()
    const collection = await prepareCollection(db, options.collection)

    const datasource = new MongoDatasource({
        connections: { default: mongo },
        databases: [DB_NAME],
    })
    await datasource.init([
        { method: 'GET', path: `/livequery/${ref}`, collection: options.collection, db: DB_NAME, realtime: true },
        { method: 'GET', path: `/livequery/${ref}/:id`, collection: options.collection, db: DB_NAME },
        { method: 'POST', path: `/livequery/${ref}`, collection: options.collection, db: DB_NAME },
        { method: 'PATCH', path: `/livequery/${ref}/:id`, collection: options.collection, db: DB_NAME },
        { method: 'DELETE', path: `/livequery/${ref}/:id`, collection: options.collection, db: DB_NAME },
    ])

    const server = http.createServer()
    const gateway = new WebsocketGateway(server)

    const runDatasource = async (req: any, routeRef: string) => {
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
        if (req.method === 'GET') gateway.handle(ctx as any)
        // Private-field hiding is handled by LivequeryInterceptor (item/items/data shapes).
        return await datasource.handle(ctx as any)
    }

    class TaskController {
        async list(req: any) { return { data: await runDatasource(req, `/livequery/${ref}`) } }
        async get(req: any) { return { data: await runDatasource(req, `/livequery/${ref}/:id`) } }
        async post(req: any) { return { data: await runDatasource(req, `/livequery/${ref}`) } }
        async patch(req: any) { return { data: await runDatasource(req, `/livequery/${ref}/:id`) } }
        async del(req: any) { return { data: await runDatasource(req, `/livequery/${ref}/:id`) } }
    }

    Controller(`livequery/${ref}`)(TaskController)
    for (const [name, decorator] of [
        ['list', Get()],
        ['get', Get(':id')],
        ['post', Post()],
        ['patch', Patch(':id')],
        ['del', Delete(':id')],
    ] as Array<[string, MethodDecorator]>) {
        Req()(TaskController.prototype, name, 0)
        applyMethodDecorator(decorator, TaskController.prototype, name)
        applyMethodDecorator(UseLivequeryInterceptor(), TaskController.prototype, name)
    }

    class TestModule { }
    Module({
        controllers: [TaskController],
        providers: [
            { provide: LivequeryInterceptor, useFactory: () => new LivequeryInterceptor(gateway as any) },
            { provide: WebsocketGateway, useValue: gateway },
        ],
    })(TestModule)

    const expressApp = express()
    expressApp.use(express.json())
    const nestApp = await NestFactory.create(TestModule, new ExpressAdapter(expressApp), {
        bodyParser: false,
        logger: false,
    })
    await nestApp.init()
    server.on('request', expressApp)

    await new Promise<void>(resolve => server.listen(0, resolve))
    const port = (server.address() as AddressInfo).port

    const realtimeSub = options.realtime !== false
        ? wireRealtime(gateway, mongo, options.collection, ref)
        : undefined

    return {
        port,
        apiUrl: `http://127.0.0.1:${port}/livequery`,
        wsUrl: `ws://127.0.0.1:${port}${WEBSOCKET_PATH}`,
        server,
        gateway,
        datasource,
        mongo,
        db,
        collection,
        nestApp,
        close: async () => {
            realtimeSub?.unsubscribe()
            await nestApp.close().catch(() => undefined)
            gateway.close()
            await closeHttpServer(server)
            await collection.deleteMany({}).catch(() => undefined)
            await mongo.close().catch(() => undefined)
        },
    }
}
