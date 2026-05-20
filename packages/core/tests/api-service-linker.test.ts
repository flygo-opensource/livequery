import { describe, expect, test } from 'bun:test'
import { Subject } from 'rxjs'
import {
    API_GATEWAY_NAMESPACE,
    ApiServiceLinker,
    WEBSOCKET_PATH,
    type ServiceApiMetadata,
} from '../src/index.js'
import type { UdpDiscovery } from '../src/UdpDiscovery.js'

describe('ApiServiceLinker', () => {
    test('publishes service metadata when started', async () => {
        const discovery = createDiscovery()
        const linker = new ApiServiceLinker({
            discovery,
            node_id: 'service-1',
            paths: [{ method: 'GET', path: 'livequery/posts' }],
        })

        linker.start('posts', 3001)

        expect(discovery.broadcasts).toHaveLength(1)
        expect(discovery.broadcasts[0]).toMatchObject({
            node_id: 'service-1',
            namespace: 'default',
            role: 'service',
            name: 'posts',
            port: 3001,
            paths: [{ method: 'GET', path: 'livequery/posts' }],
            linked: [],
        })

        linker.close()
        expect(discovery.wasClosed).toBe(true)
    })

    test('rebroadcasts with a bumped version when a gateway appears in the same namespace', async () => {
        const discovery = createDiscovery()
        const linker = new ApiServiceLinker({
            discovery,
            node_id: 'service-1',
            paths: [{ method: 'GET', path: 'livequery/posts' }],
        })
        linker.start('posts', 3001)
        const firstVersion = discovery.broadcasts[0]!.version

        discovery.next(gatewayMetadata({ node_id: 'gateway-1', version: 1 }))
        await sleep(1)

        expect(discovery.broadcasts).toHaveLength(2)
        expect(discovery.broadcasts[1]?.node_id).toBe('service-1')
        expect(discovery.broadcasts[1]!.version).toBeGreaterThanOrEqual(firstVersion)

        linker.close()
    })

    test('ignores gateways from another namespace and metadata from itself', async () => {
        const discovery = createDiscovery()
        const linker = new ApiServiceLinker({
            discovery,
            node_id: 'service-1',
            paths: [{ method: 'GET', path: 'livequery/posts' }],
        })
        linker.start('posts', 3001)

        discovery.next(gatewayMetadata({ node_id: 'gateway-other', namespace: 'other', version: 1 }))
        discovery.next(gatewayMetadata({ node_id: 'service-1', version: 2 }))
        await sleep(1)

        expect(discovery.broadcasts).toHaveLength(1)
        linker.close()
    })

    test('includes websocket metadata when a websocket gateway is provided', () => {
        const discovery = createDiscovery()
        const ws = { auth: 'secret-auth' } as any
        const linker = new ApiServiceLinker({
            discovery,
            node_id: 'service-1',
            ws,
            paths: [{ method: 'GET', path: 'livequery/posts' }],
        })

        linker.start('posts', 3001)

        expect(discovery.broadcasts[0]?.ws).toEqual({
            auth: 'secret-auth',
            path: WEBSOCKET_PATH,
        })
        linker.close()
    })

    test('start replaces the previous discovery subscription', async () => {
        const discovery = createDiscovery()
        const linker = new ApiServiceLinker({
            discovery,
            node_id: 'service-1',
            paths: [{ method: 'GET', path: 'livequery/posts' }],
        })

        linker.start('posts', 3001)
        linker.start('posts', 3002)
        discovery.next(gatewayMetadata({ node_id: 'gateway-1', version: 1 }))
        await sleep(1)

        const serviceBroadcasts = discovery.broadcasts.filter(node => node.node_id === 'service-1')
        expect(serviceBroadcasts).toHaveLength(3)
        expect(serviceBroadcasts.at(-1)?.port).toBe(3002)
        linker.close()
    })

    test('close is idempotent and stops future gateway-triggered broadcasts', async () => {
        const discovery = createDiscovery()
        const linker = new ApiServiceLinker({
            discovery,
            node_id: 'service-1',
            paths: [{ method: 'GET', path: 'livequery/posts' }],
        })

        linker.start('posts', 3001)
        linker.close()
        linker.close()
        discovery.next(gatewayMetadata({ node_id: 'gateway-1', version: 1 }))
        await sleep(1)

        expect(discovery.broadcasts).toHaveLength(1)
        expect(discovery.closeCalls).toBe(2)
    })

    test('uses the configured API gateway namespace in service metadata', () => {
        const discovery = createDiscovery()
        const linker = new ApiServiceLinker({
            discovery,
            node_id: 'service-1',
            paths: [{ method: 'GET', path: 'livequery/posts' }],
        })

        linker.start('posts', 3001)

        expect(discovery.broadcasts[0]?.namespace).toBe(API_GATEWAY_NAMESPACE)
        linker.close()
    })

    test('publishes every configured path and method in metadata', () => {
        const discovery = createDiscovery()
        const paths = [
            { method: 'GET', path: 'livequery/posts' },
            { method: 'POST', path: 'livequery/posts' },
            { method: 'PATCH', path: 'livequery/posts/:id' },
        ]
        const linker = new ApiServiceLinker({
            discovery,
            node_id: 'service-1',
            paths,
        })

        linker.start('posts', 3001)

        expect(discovery.broadcasts[0]?.paths).toEqual(paths)
        linker.close()
    })

    test('rebroadcast versions follow the latest clock value', async () => {
        const discovery = createDiscovery()
        const originalDateNow = Date.now
        let now = 1_000
        Date.now = () => now

        try {
            const linker = new ApiServiceLinker({
                discovery,
                node_id: 'service-1',
                paths: [{ method: 'GET', path: 'livequery/posts' }],
            })

            linker.start('posts', 3001)
            now = 1_001
            discovery.next(gatewayMetadata({ node_id: 'gateway-1', version: 1 }))
            await sleep(1)
            now = 1_002
            discovery.next(gatewayMetadata({ node_id: 'gateway-2', version: 1 }))
            await sleep(1)

            expect(discovery.broadcasts.map(node => node.version)).toEqual([
                1_000,
                1_001,
                1_002,
            ])
            linker.close()
        } finally {
            Date.now = originalDateNow
        }
    })

    test('broadcast rejection is caught instead of escaping start', async () => {
        const discovery = createDiscovery({ rejectBroadcast: true })
        const errors: unknown[] = []
        const originalConsoleError = console.error
        console.error = (...args: unknown[]) => {
            errors.push(args)
        }

        try {
            const linker = new ApiServiceLinker({
                discovery,
                node_id: 'service-1',
                paths: [{ method: 'GET', path: 'livequery/posts' }],
            })

            expect(() => linker.start('posts', 3001)).not.toThrow()
            await sleep(1)

            expect(discovery.broadcasts).toHaveLength(1)
            expect(errors).toHaveLength(1)
            linker.close()
        } finally {
            console.error = originalConsoleError
        }
    })
})

function createDiscovery(options?: { rejectBroadcast?: boolean }) {
    const subject = new Subject<ServiceApiMetadata>() as Subject<ServiceApiMetadata> & {
        broadcasts: ServiceApiMetadata[]
        wasClosed: boolean
        closeCalls: number
        broadcast(node: ServiceApiMetadata): Promise<void>
        close(): void
    }
    subject.broadcasts = []
    subject.wasClosed = false
    subject.closeCalls = 0
    subject.broadcast = async node => {
        subject.broadcasts.push(node)
        if (options?.rejectBroadcast) {
            throw new Error('broadcast failed')
        }
    }
    subject.close = () => {
        subject.wasClosed = true
        subject.closeCalls++
        subject.complete()
    }
    return subject as unknown as UdpDiscovery<ServiceApiMetadata> & {
        broadcasts: ServiceApiMetadata[]
        wasClosed: boolean
        closeCalls: number
        next(node: ServiceApiMetadata): void
    }
}

function gatewayMetadata(options: {
    node_id: string
    version: number
    namespace?: string
}): ServiceApiMetadata {
    return {
        node_id: options.node_id,
        host: '127.0.0.1',
        namespace: options.namespace ?? 'default',
        version: options.version,
        role: 'gateway',
        name: 'gateway',
        port: 0,
        paths: [],
        linked: [],
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}
