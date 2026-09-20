import { describe, expect, test } from 'bun:test'
import * as http from 'http'
import type { AddressInfo } from 'net'
import { Subject } from 'rxjs'
import { ApiGatewayHandler, type DiscoveryMessage, type ServiceApiMetadata } from '../../src/bun.js'

describe('ApiGatewayHandler', () => {
    test('updates a service route when the same node publishes a newer metadata version', async () => {
        const discovery = createDiscovery()
        const gateway = new ApiGatewayHandler({ discovery, node_id: 'gateway' })
        const first = await startService('first')
        const second = await startService('second')

        discovery.next(metadata({
            node_id: 'service',
            port: first.port,
            version: 1,
        }))
        await sleep(10)

        let response = await gateway.fetch(new Request('http://gateway/livequery/products'))
        expect(await response.text()).toBe('first')

        discovery.next(metadata({
            node_id: 'service',
            port: second.port,
            version: 2,
        }))
        await sleep(10)

        response = await gateway.fetch(new Request('http://gateway/livequery/products'))

        gateway.close()
        await Promise.all([closeServer(first.server), closeServer(second.server)])
        expect(await response.text()).toBe('second')
    })

    test('ignores stale metadata from an existing service node', async () => {
        const discovery = createDiscovery()
        const gateway = new ApiGatewayHandler({ discovery, node_id: 'gateway' })
        const first = await startService('first')
        const second = await startService('second')

        discovery.next(metadata({
            node_id: 'service',
            port: first.port,
            version: 2,
        }))
        discovery.next(metadata({
            node_id: 'service',
            port: second.port,
            version: 1,
        }))
        await sleep(10)

        const response = await gateway.fetch(new Request('http://gateway/livequery/products'))

        gateway.close()
        await Promise.all([closeServer(first.server), closeServer(second.server)])
        expect(await response.text()).toBe('first')
    })

    test('returns 404 when no route matches', async () => {
        const discovery = createDiscovery()
        const gateway = new ApiGatewayHandler({ discovery, node_id: 'gateway' })

        const response = await gateway.fetch(new Request('http://gateway/livequery/missing'))

        gateway.close()
        expect(response.status).toBe(404)
        expect(await response.json()).toMatchObject({ error: { status: 404, code: 'API_NOT_FOUND' } })
    })

    test('returns 503 after every host for a route is deregistered', async () => {
        const discovery = createDiscovery()
        const gateway = new ApiGatewayHandler({ discovery, node_id: 'gateway' })
        gateway.register({
            node_id: 'service',
            hostname: '127.0.0.1',
            port: 10001,
            paths: [{ method: 'GET', path: 'livequery/products' }],
        })

        gateway.deregister('service')
        const response = await gateway.fetch(new Request('http://gateway/livequery/products'))

        gateway.close()
        expect(response.status).toBe(503)
        const body = await response.json()
        expect(body).toMatchObject({ error: { status: 503, code: 'API_OFFLINE' } })
        // A9: error responses carry a human-readable message for debugging.
        expect(typeof body.error.message).toBe('string')
        expect(body.error.message.length).toBeGreaterThan(0)
    })

    test('round-robins between registered hosts for the same route', async () => {
        const discovery = createDiscovery()
        const gateway = new ApiGatewayHandler({ discovery, node_id: 'gateway' })
        const first = await startService('first')
        const second = await startService('second')

        gateway.register({
            node_id: 'service-a',
            hostname: '127.0.0.1',
            port: first.port,
            paths: [{ method: 'GET', path: 'livequery/products' }],
        })
        gateway.register({
            node_id: 'service-b',
            hostname: '127.0.0.1',
            port: second.port,
            paths: [{ method: 'GET', path: 'livequery/products' }],
        })

        const responses = await Promise.all([
            gateway.fetch(new Request('http://gateway/livequery/products')).then(r => r.text()),
            gateway.fetch(new Request('http://gateway/livequery/products')).then(r => r.text()),
            gateway.fetch(new Request('http://gateway/livequery/products')).then(r => r.text()),
        ])

        gateway.close()
        await Promise.all([closeServer(first.server), closeServer(second.server)])
        expect(responses).toEqual(['first', 'second', 'first'])
    })

    test('matches wildcard path segments', async () => {
        const discovery = createDiscovery()
        const gateway = new ApiGatewayHandler({ discovery, node_id: 'gateway' })
        const service = await startService('wildcard')

        gateway.register({
            node_id: 'service',
            hostname: '127.0.0.1',
            port: service.port,
            paths: [{ method: 'GET', path: 'livequery/:/stats' }],
        })

        const response = await gateway.fetch(new Request('http://gateway/livequery/space-1/stats'))

        gateway.close()
        await closeServer(service.server)
        expect(response.status).toBe(200)
        expect(await response.text()).toBe('wildcard')
    })

    test('matches prefixed parameter path segments', async () => {
        const discovery = createDiscovery()
        const gateway = new ApiGatewayHandler({ discovery, node_id: 'gateway' })
        const service = await startService('prefix')

        gateway.register({
            node_id: 'service',
            hostname: '127.0.0.1',
            port: service.port,
            paths: [{ method: 'GET', path: 'livequery/post:/comments' }],
        })

        const response = await gateway.fetch(new Request('http://gateway/livequery/post123/comments'))

        gateway.close()
        await closeServer(service.server)
        expect(response.status).toBe(200)
        expect(await response.text()).toBe('prefix')
    })

    test('separates handlers by HTTP method for the same path', async () => {
        const discovery = createDiscovery()
        const gateway = new ApiGatewayHandler({ discovery, node_id: 'gateway' })
        const getService = await startService('read')
        const postService = await startService('write')

        gateway.register({
            node_id: 'read-service',
            hostname: '127.0.0.1',
            port: getService.port,
            paths: [{ method: 'GET', path: 'livequery/products' }],
        })
        gateway.register({
            node_id: 'write-service',
            hostname: '127.0.0.1',
            port: postService.port,
            paths: [{ method: 'POST', path: 'livequery/products' }],
        })

        const read = await gateway.fetch(new Request('http://gateway/livequery/products'))
        const write = await gateway.fetch(new Request('http://gateway/livequery/products', {
            method: 'POST',
            body: JSON.stringify({ name: 'pen' }),
        }))

        gateway.close()
        await Promise.all([closeServer(getService.server), closeServer(postService.server)])
        expect(await read.text()).toBe('read')
        expect(await write.text()).toBe('write')
    })

    test('returns 404 when the path exists for a different HTTP method', async () => {
        const discovery = createDiscovery()
        const gateway = new ApiGatewayHandler({ discovery, node_id: 'gateway' })
        const service = await startService('read')

        gateway.register({
            node_id: 'service',
            hostname: '127.0.0.1',
            port: service.port,
            paths: [{ method: 'GET', path: 'livequery/products' }],
        })

        const response = await gateway.fetch(new Request('http://gateway/livequery/products', {
            method: 'DELETE',
        }))

        gateway.close()
        await closeServer(service.server)
        expect(response.status).toBe(404)
        expect(await response.json()).toMatchObject({ error: { status: 404, code: 'API_NOT_FOUND' } })
    })

    test('forwards realtime headers when a websocket gateway is attached', async () => {
        const discovery = createDiscovery()
        const gateway = new ApiGatewayHandler({
            discovery,
            node_id: 'gateway',
            ws: { id: 'local-ws-gateway' } as any,
        })
        const service = await startService((req, res) => {
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({
                client_id: req.headers['x-lcid'],
                gateway_id: req.headers['x-lgid'],
            }))
        })

        gateway.register({
            node_id: 'service',
            hostname: '127.0.0.1',
            port: service.port,
            paths: [{ method: 'GET', path: 'livequery/products' }],
        })

        const explicitClient = await gateway.fetch(new Request('http://gateway/livequery/products', {
            headers: { 'x-lcid': 'client-1' },
        }))
        const socketFallback = await gateway.fetch(new Request('http://gateway/livequery/products', {
            headers: { socket_id: 'client-2', 'x-lgid': 'remote-gateway' },
        }))

        gateway.close()
        await closeServer(service.server)
        expect(await explicitClient.json()).toEqual({
            client_id: 'client-1',
            gateway_id: 'local-ws-gateway',
        })
        expect(await socketFallback.json()).toEqual({
            client_id: 'client-2',
            gateway_id: 'remote-gateway',
        })
    })

    test('keeps dialing a route served by a single node even after it fails (no hard 503)', async () => {
        const discovery = createDiscovery()
        const gateway = new ApiGatewayHandler({ discovery, node_id: 'gateway' })
        const service = await startService('offline')

        gateway.register({
            node_id: 'service',
            hostname: '127.0.0.1',
            port: service.port,
            paths: [{ method: 'GET', path: 'livequery/products' }],
        })
        await closeServer(service.server)

        const first = await gateway.fetch(new Request('http://gateway/livequery/products'))
        const second = await gateway.fetch(new Request('http://gateway/livequery/products'))

        gateway.close()
        // A lone node has no healthy alternative — never hard-fail with 503; keep
        // retrying it (502) so a flapping/restarting node recovers the instant it returns.
        expect(first.status).toBe(502)
        expect(await first.json()).toMatchObject({ error: { status: 502, code: 'SERVICE_API_OFFLINE' } })
        expect(second.status).toBe(502)
        expect(await second.json()).toMatchObject({ error: { status: 502, code: 'SERVICE_API_OFFLINE' } })
    })

    test('forwards non-GET request body and query string to the target service', async () => {
        const discovery = createDiscovery()
        const gateway = new ApiGatewayHandler({ discovery, node_id: 'gateway' })
        const service = await startService(async (req, res) => {
            const body = await readBody(req)
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({
                method: req.method,
                url: req.url,
                body: JSON.parse(body),
                content_type: req.headers['content-type'],
            }))
        })

        gateway.register({
            node_id: 'service',
            hostname: '127.0.0.1',
            port: service.port,
            paths: [{ method: 'PATCH', path: 'livequery/orders/:id' }],
        })

        const response = await gateway.fetch(new Request(
            'http://gateway/livequery/orders/order-1?include=items',
            {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ status: 'running' }),
            }
        ))

        gateway.close()
        await closeServer(service.server)
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            method: 'PATCH',
            url: '/livequery/orders/order-1?include=items',
            body: { status: 'running' },
            content_type: 'application/json',
        })
    })

    test('preserves upstream response status and headers', async () => {
        const discovery = createDiscovery()
        const gateway = new ApiGatewayHandler({ discovery, node_id: 'gateway' })
        const service = await startService((_req, res) => {
            res.statusCode = 201
            res.setHeader('x-service-version', 'v2')
            res.end('created')
        })

        gateway.register({
            node_id: 'service',
            hostname: '127.0.0.1',
            port: service.port,
            paths: [{ method: 'POST', path: 'livequery/products' }],
        })

        const response = await gateway.fetch(new Request('http://gateway/livequery/products', {
            method: 'POST',
            body: 'name=pen',
        }))

        gateway.close()
        await closeServer(service.server)
        expect(response.status).toBe(201)
        expect(response.headers.get('x-service-version')).toBe('v2')
        expect(await response.text()).toBe('created')
    })

    test('removes inbound host and content-length before forwarding', async () => {
        const discovery = createDiscovery()
        const gateway = new ApiGatewayHandler({ discovery, node_id: 'gateway' })
        const service = await startService((req, res) => {
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({
                host: req.headers.host,
                content_length: req.headers['content-length'],
            }))
        })

        gateway.register({
            node_id: 'service',
            hostname: '127.0.0.1',
            port: service.port,
            paths: [{ method: 'POST', path: 'livequery/products' }],
        })

        const response = await gateway.fetch(new Request('http://gateway/livequery/products', {
            method: 'POST',
            headers: {
                host: 'bad-host.example',
                'content-length': '999',
            },
            body: 'abc',
        }))

        gateway.close()
        await closeServer(service.server)
        const forwarded = await response.json() as { host: string; content_length: string }
        expect(forwarded.host).not.toBe('bad-host.example')
        expect(forwarded.content_length).not.toBe('999')
    })

    test('prefers static routes over prefix and wildcard routes', async () => {
        const discovery = createDiscovery()
        const gateway = new ApiGatewayHandler({ discovery, node_id: 'gateway' })
        const wildcard = await startService('wildcard')
        const prefix = await startService('prefix')
        const exact = await startService('exact')

        gateway.register({
            node_id: 'wildcard-service',
            hostname: '127.0.0.1',
            port: wildcard.port,
            paths: [{ method: 'GET', path: 'livequery/:/comments' }],
        })
        gateway.register({
            node_id: 'prefix-service',
            hostname: '127.0.0.1',
            port: prefix.port,
            paths: [{ method: 'GET', path: 'livequery/post:/comments' }],
        })
        gateway.register({
            node_id: 'exact-service',
            hostname: '127.0.0.1',
            port: exact.port,
            paths: [{ method: 'GET', path: 'livequery/post123/comments' }],
        })

        const exactResponse = await gateway.fetch(new Request('http://gateway/livequery/post123/comments'))
        const prefixResponse = await gateway.fetch(new Request('http://gateway/livequery/post999/comments'))
        const wildcardResponse = await gateway.fetch(new Request('http://gateway/livequery/user999/comments'))

        gateway.close()
        await Promise.all([
            closeServer(wildcard.server),
            closeServer(prefix.server),
            closeServer(exact.server),
        ])
        expect(await exactResponse.text()).toBe('exact')
        expect(await prefixResponse.text()).toBe('prefix')
        expect(await wildcardResponse.text()).toBe('wildcard')
    })

    test('does not duplicate the same host when register is called twice', async () => {
        const discovery = createDiscovery()
        const gateway = new ApiGatewayHandler({ discovery, node_id: 'gateway' })
        const first = await startService('first')
        const second = await startService('second')

        const firstRegistration = {
            node_id: 'service-a',
            hostname: '127.0.0.1',
            port: first.port,
            paths: [{ method: 'GET', path: 'livequery/products' }],
        }
        gateway.register(firstRegistration)
        gateway.register(firstRegistration)
        gateway.register({
            node_id: 'service-b',
            hostname: '127.0.0.1',
            port: second.port,
            paths: [{ method: 'GET', path: 'livequery/products' }],
        })

        const responses = await Promise.all([
            gateway.fetch(new Request('http://gateway/livequery/products')).then(r => r.text()),
            gateway.fetch(new Request('http://gateway/livequery/products')).then(r => r.text()),
            gateway.fetch(new Request('http://gateway/livequery/products')).then(r => r.text()),
        ])

        gateway.close()
        await Promise.all([closeServer(first.server), closeServer(second.server)])
        expect(responses).toEqual(['first', 'second', 'first'])
    })

    test('deregister removes a service from every route and method', async () => {
        const discovery = createDiscovery()
        const gateway = new ApiGatewayHandler({ discovery, node_id: 'gateway' })
        gateway.register({
            node_id: 'service',
            hostname: '127.0.0.1',
            port: 10001,
            paths: [
                { method: 'GET', path: 'livequery/products' },
                { method: 'POST', path: 'livequery/products' },
                { method: 'GET', path: 'livequery/orders/:id' },
            ],
        })

        gateway.deregister('service')
        const getProducts = await gateway.fetch(new Request('http://gateway/livequery/products'))
        const postProducts = await gateway.fetch(new Request('http://gateway/livequery/products', {
            method: 'POST',
            body: '{}',
        }))
        const getOrder = await gateway.fetch(new Request('http://gateway/livequery/orders/order-1'))

        gateway.close()
        expect(getProducts.status).toBe(503)
        expect(postProducts.status).toBe(503)
        expect(getOrder.status).toBe(503)
    })

    test('ignores discovery metadata with a different namespace or non-service role', async () => {
        const discovery = createDiscovery()
        const gateway = new ApiGatewayHandler({ discovery, node_id: 'gateway' })
        const service = await startService('ignored')

        discovery.next(metadata({
            node_id: 'wrong-namespace',
            port: service.port,
            version: 1,
            namespace: 'other',
        }))
        discovery.next({
            ...metadata({
                node_id: 'gateway-metadata',
                port: service.port,
                version: 1,
            }),
            data: {
                ...metadata({
                    node_id: 'gateway-metadata',
                    port: service.port,
                    version: 1,
                }).data,
                role: 'gateway',
            },
        })
        await sleep(10)

        const response = await gateway.fetch(new Request('http://gateway/livequery/products'))

        gateway.close()
        await closeServer(service.server)
        expect(response.status).toBe(404)
    })

    test('passes upstream HTTP failures through without deregistering the service', async () => {
        const discovery = createDiscovery()
        const gateway = new ApiGatewayHandler({ discovery, node_id: 'gateway' })
        const service = await startService((_req, res) => {
            res.statusCode = 500
            res.end('service failed')
        })

        gateway.register({
            node_id: 'service',
            hostname: '127.0.0.1',
            port: service.port,
            paths: [{ method: 'GET', path: 'livequery/products' }],
        })

        const first = await gateway.fetch(new Request('http://gateway/livequery/products'))
        const second = await gateway.fetch(new Request('http://gateway/livequery/products'))

        gateway.close()
        await closeServer(service.server)
        expect(first.status).toBe(500)
        expect(await first.text()).toBe('service failed')
        expect(second.status).toBe(500)
        expect(await second.text()).toBe('service failed')
    })
})

function createDiscovery() {
    const subject = new Subject<DiscoveryMessage<ServiceApiMetadata>>() as Subject<DiscoveryMessage<ServiceApiMetadata>> & {
        broadcast(message: DiscoveryMessage<ServiceApiMetadata>): Promise<void>
        close(): void
    }
    subject.broadcast = async () => {}
    subject.close = () => subject.complete()
    return subject
}

function metadata(options: {
    node_id: string
    port: number
    version: number
    namespace?: string
}): DiscoveryMessage<ServiceApiMetadata> {
    return {
        node_id: options.node_id,
        namespace: options.namespace ?? 'default',
        tags: ['livequery', 'service'],
        version: String(options.version),
        created_at: Date.now(),
        seq: options.version,
        data: {
            host: '127.0.0.1',
            role: 'service',
            name: 'products',
            port: options.port,
            paths: [{ method: 'GET', path: 'livequery/products' }],
            linked: [],
        },
    }
}

function startService(
    bodyOrHandler: string | ((req: http.IncomingMessage, res: http.ServerResponse) => void)
): Promise<{ server: http.Server; port: number }> {
    return new Promise(resolve => {
        const handler = typeof bodyOrHandler === 'string'
            ? (_req: http.IncomingMessage, res: http.ServerResponse) => res.end(bodyOrHandler)
            : bodyOrHandler
        const server = http.createServer(handler)
        server.listen(0, () => resolve({ server, port: (server.address() as AddressInfo).port }))
    })
}

function closeServer(server: http.Server): Promise<void> {
    return new Promise(resolve => server.close(() => resolve()))
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = ''
        req.setEncoding('utf8')
        req.on('data', chunk => {
            body += chunk
        })
        req.on('end', () => resolve(body))
        req.on('error', reject)
    })
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

