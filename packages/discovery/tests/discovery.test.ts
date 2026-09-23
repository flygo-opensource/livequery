import { describe, expect, test } from 'bun:test'
import { Observable, Subject } from 'rxjs'
import { matchService } from '@livequery/core'
import { announceService } from '../src/announceService.js'
import { discoverServices } from '../src/discoverServices.js'
import type { ServiceDiscoveryMessage, ServiceDiscoveryTransport } from '../src/types.js'

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

// A network in memory: every transport hears the others (not itself), from `host`.
function network() {
    const wire = new Subject<ServiceDiscoveryMessage>()
    const join = (host: string): ServiceDiscoveryTransport => {
        let own: string | undefined
        const heard = new Observable<ServiceDiscoveryMessage>(subscriber => wire.subscribe(message => {
            if (message.node_id !== own) subscriber.next(message)
        }))
        return Object.assign(heard, {
            async broadcast(message: ServiceDiscoveryMessage) {
                own = message.node_id
                wire.next({ ...message, remote_host: host })
            },
            close() {},
        })
    }
    return { join }
}

describe('discoverServices', () => {
    test('a service is routed by its prefixes, at its address', async () => {
        const net = network()
        const directory = discoverServices({ transport: net.join('10.0.0.1') })
        const announced = announceService({ name: 'tasks', port: 8081, prefixes: ['/livequery/tasks', '/livequery/users/:user_id/tasks'], transport: net.join('10.0.0.2') })
        await tick()
        const routing = directory.routing()
        expect(matchService(routing, '/livequery/tasks/abc')).toMatchObject({ name: 'tasks', target: { url: 'http://10.0.0.2:8081' } })
        expect(matchService(routing, '/livequery/users/u1/tasks')?.name).toBe('tasks')
        expect(matchService(routing, '/livequery/other')).toBeUndefined()
        await announced.close()
        directory.close()
    })

    test('one announcement heard through several interfaces keeps one address — loopback on the same machine', async () => {
        const net = network()
        const directory = discoverServices({ transport: net.join('10.0.0.1') })
        const vpn = net.join('100.96.0.13')
        const lan = net.join('192.168.1.5')
        const local = net.join('127.0.0.1')
        const message = (seq: number) => ({ node_id: 'tasks-1', namespace: 'livequery', tags: ['livequery-service'], version: '1', created_at: Date.now(), seq, data: { role: 'service' as const, name: 'tasks', port: 8081, prefixes: ['/livequery/tasks'] } })
        await vpn.broadcast(message(1))
        await lan.broadcast(message(1))
        expect(directory.services()).toEqual({ tasks: ['http://100.96.0.13:8081'] })  // the first heard, stable
        await local.broadcast(message(2))
        await vpn.broadcast(message(3))
        expect(directory.services()).toEqual({ tasks: ['http://127.0.0.1:8081'] })   // loopback wins, and stays
        directory.close()
    })

    test('two instances share the traffic in turn; a leaving one is dropped at once', async () => {
        const net = network()
        const directory = discoverServices({ transport: net.join('10.0.0.1') })
        const a = announceService({ name: 'tasks', port: 8081, prefixes: ['/livequery/tasks'], transport: net.join('10.0.0.2') })
        const b = announceService({ name: 'tasks', port: 8081, prefixes: ['/livequery/tasks'], transport: net.join('10.0.0.3') })
        await tick()
        const urls = Array.from({ length: 4 }, () => matchService(directory.routing(), '/livequery/tasks')!.target.url)
        expect(new Set(urls)).toEqual(new Set(['http://10.0.0.2:8081', 'http://10.0.0.3:8081']))
        expect(urls[0]).not.toBe(urls[1])

        await a.close()
        await tick()
        expect(directory.services()).toEqual({ tasks: ['http://10.0.0.3:8081'] })
        await b.close()
        await tick()
        expect(matchService(directory.routing(), '/livequery/tasks')).toBeUndefined()
        directory.close()
    })

    test('a service that stops announcing is dropped after the ttl', async () => {
        const net = network()
        const directory = discoverServices({ transport: net.join('10.0.0.1'), ttl: 100 })
        const silent = announceService({ name: 'tasks', port: 8081, prefixes: ['/livequery/tasks'], interval: 60_000, transport: net.join('10.0.0.2') })
        await tick()
        expect(directory.services()).toEqual({ tasks: ['http://10.0.0.2:8081'] })
        await tick(150)
        expect(directory.services()).toEqual({})
        void silent
        directory.close()
    })

    test('declared routing stays; services with different :param names share a segment', async () => {
        const net = network()
        const directory = discoverServices({
            transport: net.join('10.0.0.1'),
            routing: { services: { static: { url: 'http://static:9000' } }, routes: { livequery: { files: { $service: 'static' } } } },
        })
        const a = announceService({ name: 'orders', port: 1, prefixes: ['/livequery/customers/:customer_id/orders'], transport: net.join('10.0.0.2') })
        const b = announceService({ name: 'profile', port: 2, prefixes: ['/livequery/customers/:id/profile'], transport: net.join('10.0.0.3') })
        await tick()
        const routing = directory.routing()
        expect(matchService(routing, '/livequery/files/x')?.name).toBe('static')
        expect(matchService(routing, '/livequery/customers/c1/orders')?.name).toBe('orders')
        expect(matchService(routing, '/livequery/customers/c1/profile')?.name).toBe('profile')
        await a.close(); await b.close()
        directory.close()
    })

    test('prefixes from a Hono app: its /livequery routes', async () => {
        const net = network()
        const directory = discoverServices({ transport: net.join('10.0.0.1') })
        const app = { routes: [{ path: '/health' }, { path: '/livequery/tasks' }, { path: '/livequery/tasks/:id' }, { path: '/livequery/*' }] }
        const announced = announceService({ name: 'tasks', port: 8081, app, transport: net.join('10.0.0.2') })
        await tick()
        expect(matchService(directory.routing(), '/livequery/tasks/1')?.name).toBe('tasks')
        expect(matchService(directory.routing(), '/health')).toBeUndefined()
        await announced.close()
        directory.close()
    })

})

describe('over real UDP on this machine', () => {
    test('a service and a gateway find each other', async () => {
        const key = `test-${crypto.randomUUID()}`
        const port = 20_000 + Math.floor(Math.random() * 10_000)
        const directory = discoverServices({ udp: { key, port } })
        const announced = announceService({ name: 'tasks', port: 8081, prefixes: ['/livequery/tasks'], udp: { key, port } })
        const started = Date.now()
        while (!directory.services().tasks && Date.now() - started < 5000) await tick(50)
        expect(directory.services().tasks?.[0]).toMatch(/^http:\/\/.+:8081$/)
        await announced.close()
        await tick(300)
        expect(directory.services()).toEqual({})
        directory.close()
    }, 10_000)

    test('a gateway started after the service learns it at once, not at the next announcement', async () => {
        const key = `test-${crypto.randomUUID()}`
        const port = 20_000 + Math.floor(Math.random() * 10_000)
        // Announces once, then not again for a minute: only the answer to the gateway's hello can
        // bring it in time.
        const announced = announceService({ name: 'tasks', port: 8081, prefixes: ['/livequery/tasks'], interval: 60_000, udp: { key, port } })
        await tick(500)
        const directory = discoverServices({ udp: { key, port } })
        const started = Date.now()
        while (!directory.services().tasks && Date.now() - started < 3000) await tick(50)
        expect(directory.services().tasks).toHaveLength(1)
        await announced.close()
        directory.close()
    }, 10_000)

    test('a gateway with another key sees nothing', async () => {
        const port = 20_000 + Math.floor(Math.random() * 10_000)
        const announced = announceService({ name: 'tasks', port: 8081, prefixes: ['/livequery/tasks'], udp: { key: 'service-key', port } })
        const directory = discoverServices({ udp: { key: 'another-key', port } })
        await tick(1000)
        expect(directory.services()).toEqual({})
        await announced.close()
        directory.close()
    }, 10_000)
})
