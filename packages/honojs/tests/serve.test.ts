import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { serve } from '../src/runtime/bun.js'
import { serve as serveWorkers } from '../src/runtime/workers.js'

describe('serve()', () => {
    test('bun: returns a Bun.serve definition that keeps the app reachable', async () => {
        const app = new Hono()
        app.get('/health', c => c.json({ ok: true }))
        const server = serve(app, { port: 1234 })

        expect(server.port).toBe(1234)
        const response = await server.fetch(new Request('http://local/health'), undefined) as Response
        expect(await response.json()).toEqual({ ok: true })
        expect('websocket' in server).toBe(false)
    })

    test('bun: a realtime gateway takes the upgrade and adds the websocket handlers', async () => {
        const app = new Hono()
        app.get('/health', c => c.json({ ok: true }))
        const handlers = { open() {} }
        const gateway = {
            attachBunUpgrade: (request: Request) => new URL(request.url).pathname === '/livequery/realtime-updates',
            getBunWebsocketHandlers: () => handlers,
        }
        const server = serve(app, { port: 1, realtime: gateway })

        expect(server.websocket).toBe(handlers)
        expect(server.fetch(new Request('http://local/livequery/realtime-updates'), undefined)).toBeUndefined()
        const response = await server.fetch(new Request('http://local/health'), undefined) as Response
        expect(response.status).toBe(200)
    })

    test('workers: the app is the export, since the platform owns the port', () => {
        const app = new Hono()
        expect(serveWorkers(app, { port: 8080 })).toBe(app)
    })
})
