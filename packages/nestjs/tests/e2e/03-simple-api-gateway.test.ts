import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import * as http from 'http'
import * as http2 from 'http2'
import * as fs from 'fs'
import * as path from 'path'
import type { AddressInfo } from 'net'
import { SimpleApiGateway } from '../../src/SimpleApiGateway.js'
import { closeServer, sleep } from './helpers.js'

// ─── Bootstrap helpers ────────────────────────────────────────────────────────

type JsonHandler = (req: http.IncomingMessage & { body?: any }) => { status?: number; body: any }

async function startService(handler: JsonHandler): Promise<{ server: http.Server; port: number }> {
    return new Promise(resolve => {
        const server = http.createServer((req, res) => {
            const chunks: Buffer[] = []
            req.on('data', c => chunks.push(c))
            req.on('end', () => {
                try {
                    const raw = Buffer.concat(chunks).toString()
                    ;(req as any).body = raw ? JSON.parse(raw) : undefined
                } catch { /* ignore */ }
                const result = handler(req as any)
                const body = JSON.stringify(result.body)
                res.writeHead(result.status ?? 200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
                res.end(body)
            })
        })
        server.listen(0, () => resolve({ server, port: (server.address() as AddressInfo).port }))
    })
}

async function startGatewayServer(gw: SimpleApiGateway): Promise<{ server: http.Server; port: number; url: string }> {
    return new Promise(resolve => {
        const server = http.createServer((req, res) => {
            const chunks: Buffer[] = []
            req.on('data', c => chunks.push(c))
            req.on('end', () => {
                ;(req as any).rawBody = Buffer.concat(chunks)
                gw.fetch(req as any, res)
            })
        })
        server.listen(0, () => {
            const port = (server.address() as AddressInfo).port
            resolve({ server, port, url: `http://127.0.0.1:${port}` })
        })
    })
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SimpleApiGateway — basic proxying', () => {
    let gw: SimpleApiGateway
    let svc: { server: http.Server; port: number }
    let proxy: { server: http.Server; port: number; url: string }

    beforeAll(async () => {
        gw = new SimpleApiGateway()

        svc = await startService((req) => ({
            body: { ok: true, method: req.method, url: req.url, body: (req as any).body }
        }))

        gw.register({
            node_id: 'svc-1',
            hostname: '127.0.0.1',
            port: svc.port,
            paths: [
                { method: 'GET',    path: 'livequery/users' },
                { method: 'POST',   path: 'livequery/users' },
                { method: 'PATCH',  path: 'livequery/users/:id' },
                { method: 'DELETE', path: 'livequery/users/:id' },
                { method: 'PUT',    path: 'livequery/users/:id' },
            ],
        })

        proxy = await startGatewayServer(gw)
    })

    afterAll(async () => {
        await Promise.all([closeServer(svc.server), closeServer(proxy.server)])
    })

    test('GET is forwarded to service', async () => {
        const res = await fetch(`${proxy.url}/livequery/users`)
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.ok).toBe(true)
        expect(body.method).toBe('GET')
    })

    test('POST with body is forwarded and body reaches service', async () => {
        const res = await fetch(`${proxy.url}/livequery/users`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Alice' }),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.method).toBe('POST')
        expect(body.body?.name).toBe('Alice')
    })

    test('PATCH with param is forwarded', async () => {
        const res = await fetch(`${proxy.url}/livequery/users/123`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Bob' }),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.method).toBe('PATCH')
    })

    test('DELETE is forwarded', async () => {
        const res = await fetch(`${proxy.url}/livequery/users/456`, { method: 'DELETE' })
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.method).toBe('DELETE')
    })

    test('PUT is forwarded', async () => {
        const res = await fetch(`${proxy.url}/livequery/users/789`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Carol' }),
        })
        expect(res.status).toBe(200)
    })
})

describe('SimpleApiGateway — routing errors', () => {
    let gw: SimpleApiGateway
    let proxy: { server: http.Server; port: number; url: string }

    beforeAll(async () => {
        gw = new SimpleApiGateway()
        const svc = await startService(() => ({ body: { ok: true } }))
        gw.register({
            node_id: 'svc-err',
            hostname: '127.0.0.1',
            port: svc.port,
            paths: [{ method: 'GET', path: 'livequery/items' }],
        })
        proxy = await startGatewayServer(gw)
    })

    afterAll(async () => { await closeServer(proxy.server) })

    test('404 for unknown route', async () => {
        const res = await fetch(`${proxy.url}/livequery/unknown`)
        expect(res.status).toBe(404)
        const body = await res.json() as any
        expect(body.error.code).toBe('API_NOT_FOUND')
    })

    test('503 after service deregistered', async () => {
        gw.deregister('svc-err')
        const res = await fetch(`${proxy.url}/livequery/items`)
        expect(res.status).toBe(503)
        const body = await res.json() as any
        expect(body.error.code).toBe('API_OFFLINE')
    })
})

describe('SimpleApiGateway — load balancing', () => {
    test('round-robin across two service instances', async () => {
        const gw = new SimpleApiGateway()

        const [svcA, svcB] = await Promise.all([
            startService(() => ({ body: { node: 'A' } })),
            startService(() => ({ body: { node: 'B' } })),
        ])

        gw.register({ node_id: 'rr-A', hostname: '127.0.0.1', port: svcA.port, paths: [{ method: 'GET', path: 'livequery/items' }] })
        gw.register({ node_id: 'rr-B', hostname: '127.0.0.1', port: svcB.port, paths: [{ method: 'GET', path: 'livequery/items' }] })

        const proxy = await startGatewayServer(gw)

        const results: string[] = []
        for (let i = 0; i < 4; i++) {
            const res = await fetch(`${proxy.url}/livequery/items`)
            const body = await res.json() as any
            results.push(body.node)
        }

        expect(results).toContain('A')
        expect(results).toContain('B')
        // alternates: A B A B
        expect(results[0]).not.toBe(results[1])
        expect(results[1]).not.toBe(results[2])

        await Promise.all([closeServer(svcA.server), closeServer(svcB.server), closeServer(proxy.server)])
    })
})

describe('SimpleApiGateway — dynamic path params', () => {
    let proxy: { server: http.Server; port: number; url: string }

    beforeAll(async () => {
        const gw = new SimpleApiGateway()
        const svc = await startService((req) => ({ body: { url: req.url } }))
        gw.register({
            node_id: 'svc-params',
            hostname: '127.0.0.1',
            port: svc.port,
            paths: [
                { method: 'GET', path: 'livequery/users/:id' },
                { method: 'GET', path: 'livequery/orgs/:orgId/members/:memberId' },
            ],
        })
        proxy = await startGatewayServer(gw)
    })

    afterAll(async () => { await closeServer(proxy.server) })

    test('matches pure param segment :id', async () => {
        const res = await fetch(`${proxy.url}/livequery/users/42`)
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.url).toContain('/livequery/users/42')
    })

    test('matches nested params', async () => {
        const res = await fetch(`${proxy.url}/livequery/orgs/acme/members/john`)
        expect(res.status).toBe(200)
    })
})

describe('SimpleApiGateway — deregister on service offline', () => {
    test('deregisters a service and marks route offline', async () => {
        const gw = new SimpleApiGateway()
        const svc = await startService(() => ({ body: { ok: true } }))

        gw.register({
            node_id: 'svc-gone',
            hostname: '127.0.0.1',
            port: svc.port,
            paths: [{ method: 'GET', path: 'livequery/gone' }],
        })

        const proxy = await startGatewayServer(gw)

        // First request succeeds
        let res = await fetch(`${proxy.url}/livequery/gone`)
        expect(res.status).toBe(200)

        // Deregister
        gw.deregister('svc-gone')

        // Now 503
        res = await fetch(`${proxy.url}/livequery/gone`)
        expect(res.status).toBe(503)

        await Promise.all([closeServer(svc.server), closeServer(proxy.server)])
    })
})
