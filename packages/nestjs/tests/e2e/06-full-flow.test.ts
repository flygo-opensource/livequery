/**
 * Full end-to-end flow tests:
 *   Client (WebSocket + HTTP) → NestJS service with LivequeryInterceptor → realtime update
 *
 * These tests exercise the complete path: REST GET registers a realtime subscription,
 * then server-side gateway.next() pushes a sync event to the subscribed client.
 */

import 'reflect-metadata'
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import {
    Controller, Get, Inject, Module, Optional,
    type INestApplication,
} from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { interval, mergeMap, mergeAll, of } from 'rxjs'
import type { AddressInfo } from 'net'
import * as http from 'http'

import { WebsocketGateway, WEBSOCKET_PATH } from '@livequery/core'
import { LivequeryInterceptor, UseLivequeryInterceptor } from '../../src/LivequeryInterceptor.js'
import { LivequeryRequest as LQDecorator } from '../../src/LivequeryRequest.js'
import type { LivequeryRequest } from '@livequery/types'
import { wsConnect, waitForWsMessage, sendJson, sleep, closeServer } from './helpers.js'

// ─── Test service controllers ─────────────────────────────────────────────────

const GW_TOKEN = 'FULL_FLOW_GATEWAY'

@Controller('livequery/todos')
class TodoController {
    constructor(
        @Optional() @Inject(GW_TOKEN) private readonly gw: WebsocketGateway | null
    ) {}

    @Get()
    @UseLivequeryInterceptor()
    async list(@LQDecorator() req: LivequeryRequest) {
        // Register a live pipe: emits one synthetic update per second
        if (this.gw) {
            await this.gw.link<any>(req.ref, (existing) => {
                if (existing) return  // already wired up
                return interval(500).pipe(
                    mergeMap(n => of({
                        ref: req.ref,
                        data: { id: `todo-${n}`, text: `Item ${n}` },
                        type: 'added' as const,
                    }))
                )
            })
        }
        return { items: [{ id: 'seed', text: 'Seed item' }] }
    }
}

@Controller('livequery/messages')
class MessageController {
    constructor(
        @Optional() @Inject(GW_TOKEN) private readonly gw: WebsocketGateway | null
    ) {}

    @Get()
    @UseLivequeryInterceptor()
    list(@LQDecorator() req: LivequeryRequest) {
        return { items: [] }
    }
}

// ─── App factory ─────────────────────────────────────────────────────────────

async function buildApp(): Promise<{
    app: INestApplication
    gateway: WebsocketGateway
    httpServer: http.Server
    port: number
    wsUrl: string
}> {
    const httpServer = http.createServer()
    await new Promise<void>(r => httpServer.listen(0, r))
    const port = (httpServer.address() as AddressInfo).port
    const gateway = new WebsocketGateway(httpServer)

    @Module({
        controllers: [TodoController, MessageController],
        providers: [
            LivequeryInterceptor,
            { provide: WebsocketGateway, useValue: gateway },
            { provide: GW_TOKEN, useValue: gateway },
        ],
    })
    class FullFlowModule {}

    const express = (await import('express')).default
    const { ExpressAdapter } = await import('@nestjs/platform-express')
    const expressApp = express()

    const app = await NestFactory.create(FullFlowModule, new ExpressAdapter(expressApp), {
        rawBody: true,
        bodyParser: false,
        logger: false,
    })
    await app.init()
    httpServer.on('request', expressApp)

    return { app, gateway, httpServer, port, wsUrl: `ws://127.0.0.1:${port}${WEBSOCKET_PATH}` }
}

// ─── Suite setup ──────────────────────────────────────────────────────────────

let app: INestApplication
let gateway: WebsocketGateway
let httpServer: http.Server
let PORT: number
let WS_URL: string

beforeAll(async () => {
    const result = await buildApp()
    app = result.app
    gateway = result.gateway
    httpServer = result.httpServer
    PORT = result.port
    WS_URL = result.wsUrl
})

afterAll(async () => {
    await app.close()
    await closeServer(httpServer)
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Full flow — GET registers subscription → gateway.next() delivers sync', () => {
    test('client receives sync after manual gateway.next()', async () => {
        const clientId = 'ff-client-manual'
        const ws = await wsConnect(WS_URL)
        sendJson(ws, { event: 'start', data: { id: clientId, auth: '' } })
        await waitForWsMessage(ws, (m: any) => m.event === 'hello')

        // GET registers the subscription
        await fetch(`http://127.0.0.1:${PORT}/livequery/messages`, {
            headers: { 'x-lcid': clientId, 'x-lgid': gateway.id },
        })
        await sleep(150)

        // Push a manual update
        const syncP = waitForWsMessage<any>(ws, m => m.event === 'sync')
        gateway.next({ ref: 'messages', data: { id: 'msg-1', text: 'Hello' }, type: 'added' } as any)

        const sync = await syncP
        expect(sync.event).toBe('sync')
        expect(sync.data.changes[0].ref).toBe('messages')
        expect(sync.data.changes[0].data.id).toBe('msg-1')

        ws.close()
    })

    test('link() pipe auto-pushes updates to subscribed client', async () => {
        const clientId = 'ff-client-pipe'
        const ws = await wsConnect(WS_URL)
        sendJson(ws, { event: 'start', data: { id: clientId, auth: '' } })
        await waitForWsMessage(ws, (m: any) => m.event === 'hello')

        // GET wires up a periodic interval pipe inside the controller
        await fetch(`http://127.0.0.1:${PORT}/livequery/todos`, {
            headers: { 'x-lcid': clientId, 'x-lgid': gateway.id },
        })

        // The pipe emits every 500ms — wait for first sync
        const sync = await waitForWsMessage<any>(ws, m => m.event === 'sync', 5000)
        expect(sync.data.changes[0].ref).toBe('todos')
        expect(sync.data.changes[0].data.id).toMatch(/^todo-\d+$/)

        ws.close()
    })

    test('two clients subscribe to same ref — both receive the update', async () => {
        const ids = ['ff-multi-1', 'ff-multi-2']
        const sockets = await Promise.all(ids.map(async (id) => {
            const ws = await wsConnect(WS_URL)
            sendJson(ws, { event: 'start', data: { id, auth: '' } })
            await waitForWsMessage(ws, (m: any) => m.event === 'hello')
            return ws
        }))

        // Both subscribe
        for (const [i, ws] of sockets.entries()) {
            await fetch(`http://127.0.0.1:${PORT}/livequery/messages`, {
                headers: { 'x-lcid': ids[i], 'x-lgid': gateway.id },
            })
        }
        await sleep(150)

        const syncs = sockets.map(ws =>
            waitForWsMessage<any>(ws, m => m.event === 'sync')
        )

        gateway.next({ ref: 'messages', data: { id: 'broadcast-msg' }, type: 'added' } as any)

        const results = await Promise.all(syncs)
        for (const sync of results) {
            expect(sync.data.changes[0].data.id).toBe('broadcast-msg')
        }

        for (const ws of sockets) ws.close()
    })

    test('client unsubscribes mid-session — no longer receives updates', async () => {
        const clientId = 'ff-unsub-mid'
        const ws = await wsConnect(WS_URL)
        sendJson(ws, { event: 'start', data: { id: clientId, auth: '' } })
        await waitForWsMessage(ws, (m: any) => m.event === 'hello')

        await fetch(`http://127.0.0.1:${PORT}/livequery/messages`, {
            headers: { 'x-lcid': clientId, 'x-lgid': gateway.id },
        })
        await sleep(100)

        // Confirm subscription works
        const firstSync = waitForWsMessage<any>(ws, m => m.event === 'sync')
        gateway.next({ ref: 'messages', data: { id: 'before-unsub' }, type: 'added' } as any)
        await firstSync

        // Unsubscribe
        sendJson(ws, { event: 'unsubscribe', data: { ref: 'messages', client_id: clientId } })
        await sleep(100)

        let afterCount = 0
        ws.addEventListener('message', (e: MessageEvent) => {
            const m = JSON.parse(e.data)
            if (m.event === 'sync') afterCount++
        })

        gateway.next({ ref: 'messages', data: { id: 'after-unsub' }, type: 'added' } as any)
        await sleep(400)

        expect(afterCount).toBe(0)
        ws.close()
    })
})

describe('Full flow — document-level subscription', () => {
    test('client subscribes to a specific doc ref and receives its update', async () => {
        const clientId = 'ff-doc-client'
        const ws = await wsConnect(WS_URL)
        sendJson(ws, { event: 'start', data: { id: clientId, auth: '' } })
        await waitForWsMessage(ws, (m: any) => m.event === 'hello')

        // Manually subscribe to a specific doc ref
        sendJson(ws, {
            event: 'subscribe',
            ref: 'messages/doc-42',
            client_id: clientId,
            gateway_id: gateway.id,
            listener_node_id: gateway.id,
        })
        await sleep(100)

        const syncP = waitForWsMessage<any>(ws, m => m.event === 'sync')
        gateway.next({ ref: 'messages', data: { id: 'doc-42', text: 'Updated' }, type: 'modified' } as any)

        const sync = await syncP
        // The gateway should deliver the update because it matches ref/doc-42
        expect(sync.data.changes[0].data.id).toBe('doc-42')

        ws.close()
    })
})

describe('Full flow — disconnect resilience', () => {
    test('server continues operating after a client disconnects mid-stream', async () => {
        const client1 = 'ff-disc-1'
        const client2 = 'ff-disc-2'

        const ws1 = await wsConnect(WS_URL)
        const ws2 = await wsConnect(WS_URL)

        for (const [id, ws] of [[client1, ws1], [client2, ws2]] as const) {
            sendJson(ws, { event: 'start', data: { id, auth: '' } })
            await waitForWsMessage(ws, (m: any) => m.event === 'hello')
            await fetch(`http://127.0.0.1:${PORT}/livequery/messages`, {
                headers: { 'x-lcid': id, 'x-lgid': gateway.id },
            })
        }
        await sleep(150)

        // Disconnect client1 abruptly
        ws1.close()
        await sleep(200)

        // client2 should still receive updates
        const syncP = waitForWsMessage<any>(ws2, m => m.event === 'sync')
        gateway.next({ ref: 'messages', data: { id: 'after-disc' }, type: 'added' } as any)

        const sync = await syncP
        expect(sync.data.changes[0].data.id).toBe('after-disc')

        ws2.close()
    })
})
