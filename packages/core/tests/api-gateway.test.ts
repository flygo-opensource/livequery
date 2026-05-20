import { describe, expect, test } from 'bun:test'
import * as http from 'http'
import type { AddressInfo } from 'net'
import { Subject } from 'rxjs'
import { ApiGatewayHandler, type ServiceApiMetadata } from '../src/index.js'
import type { UdpDiscovery } from '../src/UdpDiscovery.js'

describe('ApiGatewayHandler', () => {
    test('updates a service route when the same node publishes a newer metadata version', async () => {
        const discovery = createDiscovery()
        const gateway = new ApiGatewayHandler({ discovery, nodeId: 'gateway' })
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
        const gateway = new ApiGatewayHandler({ discovery, nodeId: 'gateway' })
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
        const gateway = new ApiGatewayHandler({ discovery, nodeId: 'gateway' })

        const response = await gateway.fetch(new Request('http://gateway/livequery/missing'))

        gateway.close()
        expect(response.status).toBe(404)
        expect(await response.json()).toEqual({ error: { status: 404, code: 'API_NOT_FOUND' } })
    })

    test('returns 503 after every host for a route is deregistered', async () => {
        const discovery = createDiscovery()
        const gateway = new ApiGatewayHandler({ discovery, nodeId: 'gateway' })
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
        expect(await response.json()).toEqual({ error: { status: 503, code: 'API_OFFLINE' } })
    })

    test('round-robins between registered hosts for the same route', async () => {
        const discovery = createDiscovery()
        const gateway = new ApiGatewayHandler({ discovery, nodeId: 'gateway' })
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
})

function createDiscovery() {
    const subject = new Subject<ServiceApiMetadata>() as Subject<ServiceApiMetadata> & {
        broadcast(node: ServiceApiMetadata): Promise<void>
        close(): void
    }
    subject.broadcast = async () => {}
    subject.close = () => subject.complete()
    return subject as unknown as UdpDiscovery<ServiceApiMetadata>
}

function metadata(options: {
    node_id: string
    port: number
    version: number
}): ServiceApiMetadata {
    return {
        node_id: options.node_id,
        host: '127.0.0.1',
        namespace: 'default',
        version: options.version,
        role: 'service',
        name: 'products',
        port: options.port,
        paths: [{ method: 'GET', path: 'livequery/products' }],
        linked: [],
    }
}

function startService(body: string): Promise<{ server: http.Server; port: number }> {
    return new Promise(resolve => {
        const server = http.createServer((_req, res) => res.end(body))
        server.listen(0, () => resolve({ server, port: (server.address() as AddressInfo).port }))
    })
}

function closeServer(server: http.Server): Promise<void> {
    return new Promise(resolve => server.close(() => resolve()))
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}
