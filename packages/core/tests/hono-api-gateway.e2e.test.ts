import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { Subject } from 'rxjs'
import {
    ApiGatewayHandler,
    ApiServiceLinker,
    type Discovery,
    type DiscoveryMessage,
    type ServiceApiMetadata,
} from '../src/node.js'

type TestDiscovery = Discovery<ServiceApiMetadata>
type HonoServer = ReturnType<typeof Bun.serve>

const gateways: ApiGatewayHandler[] = []
const linkers: ApiServiceLinker[] = []
const servers: HonoServer[] = []

afterEach(() => {
    for (const gateway of gateways.splice(0)) gateway.close()
    for (const linker of linkers.splice(0)) linker.close()
    for (const server of servers.splice(0)) server.stop(true)
})

describe('Hono services behind ApiGatewayHandler', () => {
    test('routes requests from one API gateway to two Hono services', async () => {
        const discovery = createDiscovery()
        const gateway = new ApiGatewayHandler({ discovery, node_id: 'api-gateway' })
        gateways.push(gateway)

        const catalog = startCatalogService()
        const orders = startOrdersService()

        const catalogLinker = new ApiServiceLinker({
            discovery,
            node_id: 'catalog-service',
            paths: [{ method: 'GET', path: 'livequery/catalog' }],
        })
        const ordersLinker = new ApiServiceLinker({
            discovery,
            node_id: 'orders-service',
            paths: [{ method: 'GET', path: 'livequery/orders/:id' }],
        })
        linkers.push(catalogLinker, ordersLinker)

        catalogLinker.start('catalog', catalog.port)
        ordersLinker.start('orders', orders.port)
        await sleep(10)

        const catalogResponse = await gateway.fetch(
            new Request('http://gateway/livequery/catalog')
        )
        const orderResponse = await gateway.fetch(
            new Request('http://gateway/livequery/orders/order-1?include=items', {
                headers: { 'x-request-id': 'e2e-request' },
            })
        )

        expect(catalogResponse.status).toBe(200)
        expect(await catalogResponse.json()).toEqual({
            service: 'catalog',
            runtime: 'hono',
            items: ['book', 'pen'],
        })

        expect(orderResponse.status).toBe(200)
        expect(await orderResponse.json()).toEqual({
            service: 'orders',
            runtime: 'hono',
            id: 'order-1',
            include: 'items',
            request_id: 'e2e-request',
        })
    })

    test('forwards POST JSON bodies through the gateway to a Hono service', async () => {
        const discovery = createDiscovery()
        const gateway = new ApiGatewayHandler({ discovery, node_id: 'api-gateway' })
        gateways.push(gateway)

        const orders = startOrdersService()
        const ordersLinker = new ApiServiceLinker({
            discovery,
            node_id: 'orders-service',
            paths: [{ method: 'POST', path: 'livequery/orders/:id' }],
        })
        linkers.push(ordersLinker)

        ordersLinker.start('orders', orders.port)
        await sleep(10)

        const response = await gateway.fetch(
            new Request('http://gateway/livequery/orders/order-1?include=items', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ status: 'running' }),
            })
        )

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            service: 'orders',
            runtime: 'hono',
            id: 'order-1',
            include: 'items',
            body: { status: 'running' },
        })
    })

    test('switches to a newer service metadata version when a service changes port', async () => {
        const discovery = createDiscovery()
        const gateway = new ApiGatewayHandler({ discovery, node_id: 'api-gateway' })
        gateways.push(gateway)

        const first = startVersionedCatalogService('v1')
        const second = startVersionedCatalogService('v2')
        const linker = new ApiServiceLinker({
            discovery,
            node_id: 'catalog-service',
            paths: [{ method: 'GET', path: 'livequery/catalog' }],
        })
        linkers.push(linker)

        linker.start('catalog', first.port)
        await sleep(10)
        const firstResponse = await gateway.fetch(new Request('http://gateway/livequery/catalog'))

        await sleep(2)
        linker.start('catalog', second.port)
        await sleep(10)
        const secondResponse = await gateway.fetch(new Request('http://gateway/livequery/catalog'))

        expect(await firstResponse.json()).toEqual({
            service: 'catalog',
            version: 'v1',
        })
        expect(await secondResponse.json()).toEqual({
            service: 'catalog',
            version: 'v2',
        })
    })
})

function startCatalogService() {
    const app = new Hono()
    app.get('/livequery/catalog', c => c.json({
        service: 'catalog',
        runtime: 'hono',
        items: ['book', 'pen'],
    }))
    return startHono(app)
}

function startOrdersService() {
    const app = new Hono()
    app.get('/livequery/orders/:id', c => c.json({
        service: 'orders',
        runtime: 'hono',
        id: c.req.param('id'),
        include: c.req.query('include'),
        request_id: c.req.header('x-request-id'),
    }))
    app.post('/livequery/orders/:id', async c => c.json({
        service: 'orders',
        runtime: 'hono',
        id: c.req.param('id'),
        include: c.req.query('include'),
        body: await c.req.json(),
    }))
    return startHono(app)
}

function startVersionedCatalogService(version: string) {
    const app = new Hono()
    app.get('/livequery/catalog', c => c.json({
        service: 'catalog',
        version,
    }))
    return startHono(app)
}

function startHono(app: Hono) {
    const server = Bun.serve({
        port: 0,
        fetch: app.fetch,
    })
    servers.push(server)
    return { server, port: server.port }
}

function createDiscovery() {
    const subject = new Subject<DiscoveryMessage<ServiceApiMetadata>>() as Subject<DiscoveryMessage<ServiceApiMetadata>> & {
        broadcast(message: DiscoveryMessage<ServiceApiMetadata>): Promise<void>
        close(): void
    }
    subject.broadcast = async node => {
        subject.next({
            ...node,
            data: {
                ...node.data,
                host: node.data.host || '127.0.0.1',
            },
        })
    }
    subject.close = () => subject.complete()
    return subject as TestDiscovery
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}
