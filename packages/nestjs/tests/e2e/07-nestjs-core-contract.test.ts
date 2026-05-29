import 'reflect-metadata'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Controller, Get, Module, Req, type INestApplication } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { ExpressAdapter } from '@nestjs/platform-express'
import express from 'express'
import * as http from 'http'
import type { AddressInfo } from 'net'
import { ReplaySubject } from 'rxjs'
import {
    UdpDiscovery,
    WebsocketGateway,
    type ServiceApiMetadata,
} from '@livequery/core'
import { ApiGateway } from '../../src/ApiGatewayLinker.js'
import { ApiServiceLinker } from '../../src/ApiServiceLinker.js'
import { LivequeryInterceptor, UseLivequeryInterceptor } from '../../src/LivequeryInterceptor.js'
import { LivequeryRequest as LQDecorator } from '../../src/LivequeryRequest.js'
import { closeServer } from './helpers.js'

class FakeDiscovery extends ReplaySubject<ServiceApiMetadata> {
    readonly broadcasts: ServiceApiMetadata[] = []

    constructor() {
        super(20)
    }

    async broadcast(node: ServiceApiMetadata): Promise<void> {
        const metadata = { ...node, host: node.host || '127.0.0.1' }
        this.broadcasts.push(metadata)
        this.next(metadata)
    }

    close(): void {
        this.complete()
    }
}

@Controller('livequery/contracts')
class ContractsController {
    @Get()
    @UseLivequeryInterceptor()
    list(@LQDecorator() req: any, @Req() raw: any) {
        return {
            item: {
                ref: req.ref,
                collection_ref: req.collection_ref,
                schema_collection_ref: req.schema_collection_ref,
                is_collection: req.is_collection,
                doc_id: req.doc_id ?? null,
                document_id: req.document_id ?? null,
                method: req.method,
                options: req.options,
                query: req.query,
                client_id: raw.headers['x-lcid'] ?? null,
                gateway_id: raw.headers['x-lgid'] ?? null,
            },
        }
    }

    @Get(':id')
    @UseLivequeryInterceptor()
    getOne(@LQDecorator() req: any) {
        return {
            item: {
                ref: req.ref,
                collection_ref: req.collection_ref,
                schema_collection_ref: req.schema_collection_ref,
                is_collection: req.is_collection,
                doc_id: req.doc_id ?? null,
                document_id: req.document_id ?? null,
                method: req.method,
                keys: req.keys,
            },
        }
    }
}

@Controller()
class TablesController {
    @Get('livequery/tables')
    @UseLivequeryInterceptor()
    listTables(@LQDecorator() req: any) {
        return {
            items: [
                { id: 'users', ref: req.ref },
                { id: 'orders', ref: req.ref },
            ],
        }
    }
}

describe('NestJS core contract', () => {
    let discovery: FakeDiscovery
    let serviceApp: INestApplication
    let serviceServer: http.Server
    let gatewayApp: INestApplication
    let gatewayServer: http.Server
    let gatewayWs: WebsocketGateway
    let gatewayPort: number

    beforeAll(async () => {
        discovery = new FakeDiscovery()

        serviceServer = http.createServer()
        await listen(serviceServer)
        const servicePort = (serviceServer.address() as AddressInfo).port

        @Module({
            controllers: [ContractsController, TablesController, ApiServiceLinker],
            providers: [
                LivequeryInterceptor,
                { provide: UdpDiscovery, useValue: discovery },
            ],
        })
        class ServiceModule {}

        serviceApp = await createNestApp(ServiceModule, serviceServer)
        await ApiServiceLinker.broadcast('contract-service', servicePort)

        gatewayServer = http.createServer()
        await listen(gatewayServer)
        gatewayPort = (gatewayServer.address() as AddressInfo).port
        gatewayWs = new WebsocketGateway(gatewayServer)

        @Module({
            controllers: [ApiGateway],
            providers: [
                { provide: UdpDiscovery, useValue: discovery },
                { provide: WebsocketGateway, useValue: gatewayWs },
            ],
        })
        class GatewayModule {}

        gatewayApp = await createNestApp(GatewayModule, gatewayServer)
    })

    afterAll(async () => {
        gatewayWs.close()
        discovery.close()
        await Promise.all([
            gatewayApp.close(),
            serviceApp.close(),
            closeServer(gatewayServer),
            closeServer(serviceServer),
        ])
    })

    test('ApiServiceLinker broadcasts controller routes in core metadata shape', () => {
        const serviceMetadata = discovery.broadcasts.find(node => node.role === 'service')
        expect(serviceMetadata?.name).toBe('contract-service')
        expect(serviceMetadata?.host).toBe('127.0.0.1')
        expect(serviceMetadata?.paths).toContainEqual({ method: 'GET', path: 'livequery/contracts' })
        expect(serviceMetadata?.paths).toContainEqual({ method: 'GET', path: 'livequery/contracts/:id' })
        expect(serviceMetadata?.paths).toContainEqual({ method: 'GET', path: 'livequery/tables' })
        expect(serviceMetadata?.paths.some(route => route.path.includes('undefined'))).toBe(false)
    })

    test('ApiGateway proxies through core handler and injects gateway header for realtime clients', async () => {
        const res = await fetch(`http://127.0.0.1:${gatewayPort}/livequery/contracts?status=open`, {
            headers: { 'x-lcid': 'contract-client' },
        })
        expect(res.status).toBe(200)

        const body = await res.json() as any
        expect(body.item.ref).toBe('contracts')
        expect(body.item.collection_ref).toBe('contracts')
        expect(body.item.schema_collection_ref).toBe('contracts')
        expect(body.item.is_collection).toBe(true)
        expect(body.item.doc_id).toBeNull()
        expect(body.item.document_id).toBeNull()
        expect(body.item.method).toBe('get')
        expect(body.item.options).toEqual({ status: 'open' })
        expect(body.item.query).toEqual({ status: 'open' })
        expect(body.item.client_id).toBe('contract-client')
        expect(body.item.gateway_id).toBe(gatewayWs.id)
    })

    test('root controller routes are registered so table list endpoints are visible', async () => {
        const res = await fetch(`http://127.0.0.1:${gatewayPort}/livequery/tables`)
        expect(res.status).toBe(200)

        const body = await res.json() as any
        expect(body.items.map((item: any) => item.id)).toEqual(['users', 'orders'])
        expect(body.items[0].ref).toBe('tables')
    })

    test('LivequeryInterceptor keeps legacy document fields while using core parser', async () => {
        const res = await fetch(`http://127.0.0.1:${gatewayPort}/livequery/contracts/doc-42`)
        expect(res.status).toBe(200)

        const body = await res.json() as any
        expect(body.item.ref).toBe('contracts/doc-42')
        expect(body.item.collection_ref).toBe('contracts')
        expect(body.item.schema_collection_ref).toBe('contracts')
        expect(body.item.is_collection).toBe(false)
        expect(body.item.doc_id).toBe('doc-42')
        expect(body.item.document_id).toBe('doc-42')
        expect(body.item.keys).toEqual({ id: 'doc-42' })
    })
})

async function createNestApp(module: any, server: http.Server): Promise<INestApplication> {
    const expressApp = express()
    const app = await NestFactory.create(module, new ExpressAdapter(expressApp), {
        rawBody: true,
        bodyParser: false,
        logger: false,
    })
    await app.init()
    server.on('request', expressApp)
    return app
}

function listen(server: http.Server): Promise<void> {
    return new Promise(resolve => {
        server.listen(0, () => resolve())
    })
}
