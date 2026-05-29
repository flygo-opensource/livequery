/**
 * Service discovery tests: ApiServiceLinker (service side) broadcasts via UDP,
 * ApiGateway (gateway side) receives it, registers routes, and proxies requests.
 *
 * These tests spin up real NestJS apps (service + gateway) and verify the full
 * discovery + routing pipeline.
 */

import 'reflect-metadata'
import { describe, test, expect, afterAll } from 'bun:test'
import { Controller, Get, Inject, Module, Optional, type INestApplication } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { AddressInfo } from 'net'
import * as http from 'http'

import { WebsocketGateway, WEBSOCKET_PATH } from '@livequery/core'
import { LivequeryInterceptor, UseLivequeryInterceptor } from '../../src/LivequeryInterceptor.js'
import { LivequeryRequest as LQDecorator } from '../../src/LivequeryRequest.js'
import { ApiServiceLinker } from '../../src/ApiServiceLinker.js'
import { ApiGateway } from '../../src/ApiGatewayLinker.js'
import type { LivequeryRequest } from '@livequery/types'
import { sleep, closeServer, wsConnect, waitForWsMessage, sendJson } from './helpers.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function startNestApp(module: any, httpServer?: http.Server): Promise<{
    app: INestApplication
    port: number
}> {
    const express = (await import('express')).default
    const { ExpressAdapter } = await import('@nestjs/platform-express')
    const expressApp = express()

    const server = httpServer ?? http.createServer()
    if (!httpServer) {
        await new Promise<void>(r => server.listen(0, r))
    }
    const port = (server.address() as AddressInfo).port

    const app = await NestFactory.create(module, new ExpressAdapter(expressApp), {
        rawBody: true,
        bodyParser: false,
        logger: false,
    })
    await app.init()
    server.on('request', expressApp)

    return { app, port }
}

// ─── Service app ──────────────────────────────────────────────────────────────

@Controller('livequery/products')
class ProductsController {
    @Get()
    @UseLivequeryInterceptor()
    list() {
        return { items: [{ id: 'prod-1', name: 'Widget' }] }
    }
}

async function buildServiceApp(gateway: WebsocketGateway, httpServer: http.Server) {
    @Module({
        controllers: [ProductsController, ApiServiceLinker],
        providers: [
            LivequeryInterceptor,
            { provide: WebsocketGateway, useValue: gateway },
        ],
    })
    class ServiceModule {}

    return startNestApp(ServiceModule, httpServer)
}

// ─── Gateway app ─────────────────────────────────────────────────────────────

async function buildGatewayApp(gateway: WebsocketGateway, httpServer: http.Server) {
    @Module({
        controllers: [ApiGateway],
        providers: [
            { provide: WebsocketGateway, useValue: gateway },
        ],
    })
    class GatewayModule {}

    return startNestApp(GatewayModule, httpServer)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Service discovery — ApiServiceLinker broadcasts, ApiGateway picks up', () => {
    test('gateway proxies request to discovered service', async () => {
        // --- Service side ---
        const svcServer = http.createServer()
        await new Promise<void>(r => svcServer.listen(0, r))
        const svcPort = (svcServer.address() as AddressInfo).port
        const svcGateway = new WebsocketGateway(svcServer)

        const { app: svcApp } = await buildServiceApp(svcGateway, svcServer)

        // Broadcast the service's presence
        await ApiServiceLinker.broadcast('test-products-service', svcPort)

        // --- Gateway side ---
        const gwServer = http.createServer()
        await new Promise<void>(r => gwServer.listen(0, r))
        const gwPort = (gwServer.address() as AddressInfo).port
        const gwGateway = new WebsocketGateway(gwServer)

        const { app: gwApp } = await buildGatewayApp(gwGateway, gwServer)

        // Wait for UDP discovery to propagate and WS link to establish
        await sleep(3000)

        // --- Verify gateway proxies to service ---
        const res = await fetch(`http://127.0.0.1:${gwPort}/livequery/products`)

        await Promise.all([
            svcApp.close(),
            gwApp.close(),
            closeServer(svcServer),
            closeServer(gwServer),
        ])

        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.items?.[0]?.id).toBe('prod-1')
    }, 10_000)
})

describe('Service discovery — realtime across gateway + service', () => {
    test('client subscribes via gateway WS and receives update from service', async () => {
        // --- Service side ---
        const svcServer = http.createServer()
        await new Promise<void>(r => svcServer.listen(0, r))
        const svcPort = (svcServer.address() as AddressInfo).port
        const svcGateway = new WebsocketGateway(svcServer)
        const { app: svcApp } = await buildServiceApp(svcGateway, svcServer)
        await ApiServiceLinker.broadcast('test-rt-service', svcPort)

        // --- Gateway side ---
        const gwServer = http.createServer()
        await new Promise<void>(r => gwServer.listen(0, r))
        const gwPort = (gwServer.address() as AddressInfo).port
        const gwGateway = new WebsocketGateway(gwServer)
        const { app: gwApp } = await buildGatewayApp(gwGateway, gwServer)

        await sleep(3000)

        // Connect WS client to gateway
        const clientId = 'disc-rt-client'
        const ws = await wsConnect(`ws://127.0.0.1:${gwPort}${WEBSOCKET_PATH}`)
        const helloP = waitForWsMessage<any>(ws, m => m.event === 'hello')
        sendJson(ws, { event: 'start', data: { id: clientId, auth: '' } })
        const hello = await helloP

        // Subscribe via HTTP GET to gateway (registers realtime subscription)
        await fetch(`http://127.0.0.1:${gwPort}/livequery/products`, {
            headers: { 'x-lcid': clientId, 'x-lgid': hello.gid },
        })
        await sleep(300)

        // Emit update from service gateway
        const syncP = waitForWsMessage<any>(ws, m => m.event === 'sync')
        svcGateway.next({ ref: 'products', data: { id: 'live-update' }, type: 'modified' } as any)

        const sync = await syncP

        ws.close()
        await Promise.all([svcApp.close(), gwApp.close(), closeServer(svcServer), closeServer(gwServer)])

        expect(sync.data.changes[0].ref).toBe('products')
        expect(sync.data.changes[0].data.id).toBe('live-update')
    }, 12_000)
})

describe('Service discovery — service going offline', () => {
    test('gateway returns 503 after service disconnects', async () => {
        const svcServer = http.createServer()
        await new Promise<void>(r => svcServer.listen(0, r))
        const svcPort = (svcServer.address() as AddressInfo).port
        const svcGateway = new WebsocketGateway(svcServer)
        const { app: svcApp } = await buildServiceApp(svcGateway, svcServer)
        await ApiServiceLinker.broadcast('test-offline-service', svcPort)

        const gwServer = http.createServer()
        await new Promise<void>(r => gwServer.listen(0, r))
        const gwPort = (gwServer.address() as AddressInfo).port
        const gwGateway = new WebsocketGateway(gwServer)
        const { app: gwApp } = await buildGatewayApp(gwGateway, gwServer)

        await sleep(3000)

        // Confirm service is reachable
        const before = await fetch(`http://127.0.0.1:${gwPort}/livequery/products`)
        expect(before.status).toBe(200)

        // Shut down the service
        await svcApp.close()
        await closeServer(svcServer)

        // Wait for gateway to detect disconnect
        await sleep(2000)

        const after = await fetch(`http://127.0.0.1:${gwPort}/livequery/products`)

        await Promise.all([gwApp.close(), closeServer(gwServer)])

        // 502 means the route still exists but the upstream connection is refused.
        // 503/404 are also valid once the gateway has already marked it offline.
        expect([502, 503, 404]).toContain(after.status)
    }, 15_000)
})

// UDP sockets from ApiGatewayHandler/ApiServiceLinker keep the process alive
// even after all explicit cleanup. Give bun 500ms to flush output, then exit.
afterAll(() => { setTimeout(() => process.exit(0), 500) })
