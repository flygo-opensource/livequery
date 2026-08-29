import { describe, expect, test } from 'bun:test'
import * as http from 'http'
import type { AddressInfo } from 'net'
import { Hono } from 'hono'
import {
    createLivequery,
    HonoApiGateway,
    HonoApiGatewayLinker,
    HonoApiServiceLinker,
    livequeryJson,
    API_GATEWAY_NAMESPACE,
    UdpDiscovery,
} from '../src/index.js'
import type { ServiceApiMetadata } from '@livequery/bunjs'

describe('HonoApiGateway', () => {
    test('proxies a matched route with Fetch Request/Response', async () => {
        const service = await startService((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ method: req.method, url: req.url }))
        })

        const gateway = new HonoApiGateway()
        gateway.register({
            node_id: 'svc-1',
            hostname: '127.0.0.1',
            port: service.port,
            paths: [{ method: 'GET', path: 'livequery/products/:id' }],
        })

        const res = await gateway.fetch(new Request('http://gateway/livequery/products/p-1?x=1'))
        gateway.close()
        await closeServer(service.server)

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            method: 'GET',
            url: '/livequery/products/p-1?x=1',
        })
    })

    test('returns 404 for unknown route', async () => {
        const gateway = new HonoApiGateway()
        const res = await gateway.fetch(new Request('http://gateway/livequery/missing'))
        gateway.close()
        expect(res.status).toBe(404)
        expect((await res.json() as any).error.code).toBe('API_NOT_FOUND')
    })

    test('gateway linker auto-discovers service API through UdpDiscovery', async () => {
        const port = await getAvailablePort()
        const key = `test-key-${Date.now()}`

        const serviceApp = new Hono()
        const serviceLivequery = createLivequery(serviceApp)
        serviceLivequery.get('/livequery/products', c => livequeryJson(c, {
            items: [{ id: 'p-1', name: 'Product 1' }],
        }))

        const service = await startService((req, res) => {
            serviceApp.fetch(toRequest(req)).then(async response => {
                res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
                res.end(Buffer.from(await response.arrayBuffer()))
            })
        })

        const serviceDiscovery = new UdpDiscovery<ServiceApiMetadata>({
            key,
            port,
            namespace: API_GATEWAY_NAMESPACE,
            tags: ['livequery'],
            node_id: 'hono-service',
        })
        const gatewayDiscovery = new UdpDiscovery<ServiceApiMetadata>({
            key,
            port,
            namespace: API_GATEWAY_NAMESPACE,
            tags: ['livequery'],
            node_id: 'hono-gateway',
        })
        const serviceLinker = new HonoApiServiceLinker({
            routes: serviceLivequery.registry,
            discovery: serviceDiscovery,
            node_id: 'hono-service',
        })
        const gatewayLinker = new HonoApiGatewayLinker({
            discovery: gatewayDiscovery,
            node_id: 'hono-gateway',
        })

        serviceLinker.start('products-service', service.port)
        await sleep(500)

        const res = await gatewayLinker.gateway.fetch(new Request('http://gateway/livequery/products'))

        serviceLinker.close()
        gatewayLinker.close()
        await closeServer(service.server)

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            items: [{ id: 'p-1', name: 'Product 1' }],
        })
    })
})

function startService(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<{ server: http.Server; port: number }> {
    return new Promise(resolve => {
        const server = http.createServer(handler)
        server.listen(0, () => resolve({ server, port: (server.address() as AddressInfo).port }))
    })
}

function closeServer(server: http.Server): Promise<void> {
    return new Promise(resolve => {
        server.close(() => resolve())
    })
}

function getAvailablePort(): Promise<number> {
    return new Promise(resolve => {
        const server = http.createServer()
        server.listen(0, () => {
            const port = (server.address() as AddressInfo).port
            server.close(() => resolve(port))
        })
    })
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function toRequest(req: http.IncomingMessage): Request {
    const host = req.headers.host ?? '127.0.0.1'
    return new Request(`http://${host}${req.url ?? '/'}`, {
        method: req.method,
        headers: req.headers as HeadersInit,
    })
}
