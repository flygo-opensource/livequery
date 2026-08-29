import { afterEach, describe, expect, test } from 'bun:test'
import { filter, firstValueFrom, timeout } from 'rxjs'
import { HttpDiscovery, isDiscoveryOfflineData, type DiscoveryMessage } from '../src/index.js'

type Metadata = {
    role: 'service' | 'gateway'
    name: string
    port: number
    paths: Array<{ method: string; path: string }>
    linked: string[]
}

const discoveries: HttpDiscovery<Metadata>[] = []

afterEach(() => {
    for (const discovery of discoveries.splice(0)) {
        discovery.close()
    }
})

describe('HttpDiscovery', () => {
    test('registers a service message through a gateway registry', async () => {
        const gateway = createDiscovery({
            namespace: 'test',
            tags: ['livequery'],
            key: 'secret',
            port: 0,
            heartbeatMs: 0,
        })
        await waitReady(gateway)

        const service = createDiscovery({
            namespace: 'test',
            tags: ['livequery'],
            key: 'secret',
            node_id: 'service-1',
            listen: false,
            gateways: [`127.0.0.1:${gateway.port}`],
            heartbeatMs: 0,
        })

        const received = firstValueFrom(gateway.pipe(timeout({ first: 1_000 })))
        await service.broadcast(message({ node_id: 'service-1', seq: 1 }))

        expect(await received).toMatchObject({
            node_id: 'service-1',
            namespace: 'test',
            tags: ['livequery', 'service'],
            data: { role: 'service', name: 'posts' },
            remote_host: '127.0.0.1',
        })
    })

    test('rejects register requests with an invalid bearer token', async () => {
        const gateway = createDiscovery({
            namespace: 'test',
            tags: ['livequery'],
            key: 'secret',
            port: 0,
        })
        await waitReady(gateway)

        const response = await fetch(`http://127.0.0.1:${gateway.port}/register`, {
            method: 'POST',
            headers: {
                authorization: 'Bearer wrong',
                'content-type': 'application/json',
            },
            body: JSON.stringify(message({ node_id: 'service-1', seq: 1 })),
        })

        expect(response.status).toBe(401)
    })

    test('exposes health and authenticated node snapshots', async () => {
        const gateway = createDiscovery({
            namespace: 'test',
            tags: ['livequery'],
            key: 'secret',
            port: 0,
        })
        await waitReady(gateway)

        expect((await fetch(`http://127.0.0.1:${gateway.port}/health`)).status).toBe(200)
        expect((await fetch(`http://127.0.0.1:${gateway.port}/nodes`)).status).toBe(401)

        await post(gateway, message({ node_id: 'service-1', seq: 1 }))
        const response = await fetch(`http://127.0.0.1:${gateway.port}/nodes`, {
            headers: { authorization: 'Bearer secret' },
        })
        const body = await response.json() as { nodes: Array<DiscoveryMessage<Metadata>> }

        expect(response.status).toBe(200)
        expect(body.nodes).toHaveLength(1)
        expect(body.nodes[0]).toMatchObject({
            node_id: 'service-1',
            seq: 1,
            data: { role: 'service', name: 'posts' },
        })
    })

    test('filters inbound messages by namespace and required tags', async () => {
        const gateway = createDiscovery({
            namespace: 'test',
            tags: ['livequery', 'service'],
            key: 'secret',
            port: 0,
        })
        await waitReady(gateway)

        const wrongNamespace = await post(gateway, message({ node_id: 'service-1', namespace: 'other', seq: 1 }))
        const missingTag = await post(gateway, message({ node_id: 'service-2', tags: ['livequery'], seq: 1 }))

        expect(wrongNamespace.status).toBe(400)
        expect(missingTag.status).toBe(400)
    })

    test('rejects outbound messages that do not match constructor options', async () => {
        const service = createDiscovery({
            namespace: 'test',
            tags: ['livequery', 'service'],
            key: 'secret',
            node_id: 'service-1',
            listen: false,
            gateways: [],
        })

        await expect(service.broadcast(message({ node_id: 'service-2', seq: 1 }))).rejects.toThrow('node_id')
        await expect(service.broadcast(message({ node_id: 'service-1', namespace: 'other', seq: 1 }))).rejects.toThrow('namespace')
        await expect(service.broadcast(message({ node_id: 'service-1', tags: ['livequery'], seq: 1 }))).rejects.toThrow('tags')
    })

    test('emits an offline event when a node misses the TTL', async () => {
        const gateway = createDiscovery({
            namespace: 'test',
            tags: ['livequery'],
            key: 'secret',
            port: 0,
            ttlMs: 80,
        })
        await waitReady(gateway)

        const offline = firstValueFrom(gateway.pipe(
            filter(event => isDiscoveryOfflineData(event.data)),
            timeout({ first: 1_000 }),
        ))
        await post(gateway, message({ node_id: 'service-1', seq: 1 }))

        expect(await offline).toMatchObject({
            node_id: 'service-1',
            data: { status: 'offline' },
        })
    })

    test('heartbeats rebroadcast the last message with bumped sequence metadata', async () => {
        const gateway = createDiscovery({
            namespace: 'test',
            tags: ['livequery'],
            key: 'secret',
            port: 0,
            ttlMs: 1_000,
        })
        await waitReady(gateway)

        const service = createDiscovery({
            namespace: 'test',
            tags: ['livequery'],
            key: 'secret',
            node_id: 'service-1',
            listen: false,
            gateways: [`127.0.0.1:${gateway.port}`],
            heartbeatMs: 20,
        })

        const heartbeat = firstValueFrom(gateway.pipe(
            filter(event => event.node_id === 'service-1' && event.seq > 1),
            timeout({ first: 1_000 }),
        ))
        await service.broadcast(message({ node_id: 'service-1', seq: 1 }))

        const received = await heartbeat
        expect(received.seq).toBeGreaterThan(1)
        expect(Number(received.version)).toBeGreaterThan(0)
        expect(received.created_at).toBeGreaterThan(0)
    })

    test('retries registration when a gateway is not ready yet', async () => {
        const port = randomPort()
        const service = createDiscovery({
            namespace: 'test',
            tags: ['livequery'],
            key: 'secret',
            node_id: 'service-1',
            listen: false,
            gateways: [`127.0.0.1:${port}`],
            heartbeatMs: 0,
            requestTimeoutMs: 50,
        })

        await service.broadcast(message({ node_id: 'service-1', seq: 1 }))
        await sleep(80)

        const gateway = createDiscovery({
            namespace: 'test',
            tags: ['livequery'],
            key: 'secret',
            port,
        })
        await waitReady(gateway)

        const received = await firstValueFrom(gateway.pipe(
            filter(event => event.node_id === 'service-1'),
            timeout({ first: 1_000 }),
        ))

        expect(received.seq).toBeGreaterThan(1)
        expect(received.data).toMatchObject({ role: 'service', name: 'posts' })
    })

    test('close sends best-effort deregistration for the last broadcast message', async () => {
        const gateway = createDiscovery({
            namespace: 'test',
            tags: ['livequery'],
            key: 'secret',
            port: 0,
        })
        await waitReady(gateway)

        const service = createDiscovery({
            namespace: 'test',
            tags: ['livequery'],
            key: 'secret',
            node_id: 'service-1',
            listen: false,
            gateways: [`127.0.0.1:${gateway.port}`],
            heartbeatMs: 0,
        })

        await service.broadcast(message({ node_id: 'service-1', seq: 1 }))
        const offline = firstValueFrom(gateway.pipe(
            filter(event => isDiscoveryOfflineData(event.data)),
            timeout({ first: 1_000 }),
        ))

        service.close()

        expect(await offline).toMatchObject({
            node_id: 'service-1',
            data: { status: 'offline' },
        })
    })
})

function createDiscovery(options: ConstructorParameters<typeof HttpDiscovery<Metadata>>[0]) {
    const discovery = new HttpDiscovery<Metadata>(options)
    discoveries.push(discovery)
    return discovery
}

async function post(gateway: HttpDiscovery<Metadata>, body: DiscoveryMessage<Metadata>) {
    return fetch(`http://127.0.0.1:${gateway.port}/register`, {
        method: 'POST',
        headers: {
            authorization: 'Bearer secret',
            'content-type': 'application/json',
        },
        body: JSON.stringify(body),
    })
}

function message(options: {
    node_id: string
    seq: number
    namespace?: string
    tags?: string[]
}): DiscoveryMessage<Metadata> {
    return {
        node_id: options.node_id,
        namespace: options.namespace ?? 'test',
        tags: options.tags ?? ['livequery', 'service'],
        version: String(options.seq),
        created_at: Date.now(),
        seq: options.seq,
        data: {
            role: 'service',
            name: 'posts',
            port: 3001,
            paths: [{ method: 'GET', path: 'livequery/posts' }],
            linked: [],
        },
    }
}

function waitReady(discovery: HttpDiscovery<Metadata>): Promise<void> {
    if (discovery.port !== undefined) return Promise.resolve()
    return new Promise(resolve => {
        const timer = setInterval(() => {
            if (discovery.port === undefined) return
            clearInterval(timer)
            resolve()
        }, 5)
    })
}

function randomPort() {
    return 40_000 + Math.floor(Math.random() * 10_000)
}

function sleep(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms))
}

