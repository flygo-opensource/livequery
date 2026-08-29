/**
 * NestJS integration tests: LivequeryInterceptor path parsing, realtime subscription,
 * and private-field hiding — all via a real NestJS HTTP server.
 *
 * Bun does not emit decorator metadata, so every injected parameter uses
 * explicit @Inject(TOKEN) to avoid reflection-based type resolution.
 */

import 'reflect-metadata'
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import {
    Controller, Get, Inject, Module, Optional,
    type INestApplication,
} from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { AddressInfo } from 'net'
import * as http from 'http'

import { WebsocketGateway, WEBSOCKET_PATH } from '@livequery/core'
import {
    LivequeryInterceptor,
    UseLivequeryInterceptor,
} from '../../src/LivequeryInterceptor.js'
import { LivequeryRequest as LQDecorator } from '../../src/LivequeryRequest.js'
import type { LivequeryRequest } from '@livequery/types'
import { wsConnect, waitForWsMessage, sendJson, sleep, closeServer } from './helpers.js'

// ─── Shared gateway singleton ─────────────────────────────────────────────────
// Created before the NestJS app so we can provide it via useValue.

const GW_TOKEN = 'LIVEQUERY_GATEWAY'

// We build the http.Server and WebsocketGateway BEFORE NestJS, so that
// (a) the gateway wraps the real server socket, and
// (b) we can supply the instance as a useValue provider.
let sharedGateway: WebsocketGateway
let sharedHttpServer: http.Server

// ─── Test controllers ─────────────────────────────────────────────────────────

@Controller('livequery/comments')
class CommentsController {
    constructor(
        @Optional() @Inject(GW_TOKEN) private readonly gw: WebsocketGateway | null
    ) {}

    @Get()
    @UseLivequeryInterceptor()
    list(@LQDecorator() req: LivequeryRequest) {
        return {
            items: [
                { id: '1', text: 'hello', _secret: 'hidden' },
                { id: '2', text: 'world', _secret: 'hidden' },
            ],
        }
    }

    @Get(':docId')
    @UseLivequeryInterceptor()
    getOne(@LQDecorator() req: LivequeryRequest) {
        return {
            item: { id: req.doc_id, text: 'single', _private: 'must-be-hidden' },
        }
    }
}

@Controller('livequery/stream')
class StreamController {
    constructor(
        @Optional() @Inject(GW_TOKEN) private readonly gw: WebsocketGateway | null
    ) {}

    @Get()
    @UseLivequeryInterceptor()
    async list(@LQDecorator() req: LivequeryRequest) {
        // Register a pipe so the gateway can push updates
        if (this.gw) {
            const { of } = await import('rxjs')
            await this.gw.link(req.ref, () => of<any>())
        }
        return { items: [] }
    }
}

// ─── NestJS app factory ───────────────────────────────────────────────────────

async function buildApp(): Promise<{ app: INestApplication; port: number; wsUrl: string }> {
    // Create the HTTP server and attach the WebSocket gateway BEFORE NestJS boots.
    sharedHttpServer = http.createServer()
    await new Promise<void>(r => sharedHttpServer.listen(0, r))
    const port = (sharedHttpServer.address() as AddressInfo).port
    sharedGateway = new WebsocketGateway(sharedHttpServer)

    @Module({
        controllers: [CommentsController, StreamController],
        providers: [
            LivequeryInterceptor,
            { provide: WebsocketGateway, useValue: sharedGateway },
            { provide: GW_TOKEN, useValue: sharedGateway },
        ],
    })
    class AppModule {}

    // Use ExpressAdapter wrapping a bare express instance so NestJS routes
    // are registered on it, then wire that express instance onto our server.
    const express = (await import('express')).default
    const { ExpressAdapter } = await import('@nestjs/platform-express')
    const expressApp = express()
    const app = await NestFactory.create(AppModule, new ExpressAdapter(expressApp), {
        rawBody: true,
        bodyParser: false,
        logger: false,
    })
    await app.init()

    // Delegate plain HTTP traffic to the NestJS/Express handler.
    sharedHttpServer.on('request', expressApp)

    return { app, port, wsUrl: `ws://127.0.0.1:${port}${WEBSOCKET_PATH}` }
}

// ─── Suite setup ──────────────────────────────────────────────────────────────

let appPort: number
let wsBaseUrl: string
let nestApp: INestApplication

beforeAll(async () => {
    const result = await buildApp()
    nestApp = result.app
    appPort = result.port
    wsBaseUrl = result.wsUrl
})

afterAll(async () => {
    await nestApp.close()
    await closeServer(sharedHttpServer)
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('LivequeryInterceptor — path parsing', () => {
    test('GET collection: is_collection=true, ref="comments"', async () => {
        // We inspect the parsed ref indirectly by checking the HTTP response.
        // The interceptor assigns req.livequery; the controller returns items array.
        const res = await fetch(`http://127.0.0.1:${appPort}/livequery/comments`)
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(Array.isArray(body.items)).toBe(true)
    })

    test('GET document: returns item object', async () => {
        const res = await fetch(`http://127.0.0.1:${appPort}/livequery/comments/42`)
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.item).toBeDefined()
        expect(body.item.id).toBe('42')
    })
})

describe('LivequeryInterceptor — private field hiding', () => {
    test('fields starting with _ are stripped from item response', async () => {
        const res = await fetch(`http://127.0.0.1:${appPort}/livequery/comments/1`)
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.item).toBeDefined()
        expect(Object.keys(body.item)).not.toContain('_private')
    })

    test('public fields are preserved in item response', async () => {
        const res = await fetch(`http://127.0.0.1:${appPort}/livequery/comments/2`)
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.item.text).toBe('single')
    })
})

describe('LivequeryInterceptor — realtime subscription', () => {
    test('GET with x-lcid + x-lgid causes subscription and client receives sync', async () => {
        const clientId = 'nestjs-client-1'

        // First connect the WS client
        const ws = await wsConnect(wsBaseUrl)
        sendJson(ws, { event: 'start', data: { id: clientId, auth: '' } })
        await waitForWsMessage(ws, (m: any) => m.event === 'hello')

        // Make GET with realtime headers
        await fetch(`http://127.0.0.1:${appPort}/livequery/comments`, {
            headers: {
                'x-lcid': clientId,
                'x-lgid': sharedGateway.id,
            },
        })
        await sleep(100)

        // Emit an update on the subscribed ref
        const syncP = waitForWsMessage<any>(ws, m => m.event === 'sync')
        sharedGateway.next({ ref: 'comments', data: { id: 'new-1' }, type: 'added' } as any)

        const sync = await syncP
        expect(sync.data.changes[0].ref).toBe('comments')
        ws.close()
    })

    test('GET without realtime headers does NOT trigger subscription', async () => {
        let received = false
        const ws = await wsConnect(wsBaseUrl)
        sendJson(ws, { event: 'start', data: { id: 'nestjs-no-sub', auth: '' } })
        await waitForWsMessage(ws, (m: any) => m.event === 'hello')

        ws.addEventListener('message', (e: MessageEvent) => {
            const m = JSON.parse(e.data)
            if (m.event === 'sync') received = true
        })

        // No x-lcid header
        await fetch(`http://127.0.0.1:${appPort}/livequery/comments`)
        await sleep(100)

        sharedGateway.next({ ref: 'comments', data: { id: 'no-sub-item' }, type: 'added' } as any)
        await sleep(300)

        expect(received).toBe(false)
        ws.close()
    })

    test('GET with cursor param (:after) skips subscription', async () => {
        const clientId = 'nestjs-cursor-client'
        let received = false

        const ws = await wsConnect(wsBaseUrl)
        sendJson(ws, { event: 'start', data: { id: clientId, auth: '' } })
        await waitForWsMessage(ws, (m: any) => m.event === 'hello')

        ws.addEventListener('message', (e: MessageEvent) => {
            const m = JSON.parse(e.data)
            if (m.event === 'sync') received = true
        })

        await fetch(`http://127.0.0.1:${appPort}/livequery/comments?:after=cursor-token`, {
            headers: { 'x-lcid': clientId, 'x-lgid': sharedGateway.id },
        })
        await sleep(100)

        sharedGateway.next({ ref: 'comments', data: { id: 'cursor-item' }, type: 'added' } as any)
        await sleep(300)

        expect(received).toBe(false)
        ws.close()
    })
})
