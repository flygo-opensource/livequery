import { describe, expect, test } from 'bun:test'
import { Observable, Subject } from 'rxjs'
import { matchService } from '@livequery/core'
import { announceService } from '../src/announceService.js'
import { discoverServices } from '../src/discoverServices.js'
import type { ServiceDiscoveryMessage, ServiceDiscoveryTransport } from '../src/types.js'

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

async function waitUntil(check: () => boolean, ms = 3000) {
    const started = Date.now()
    while (!check()) {
        if (Date.now() - started > ms) throw new Error('timed out')
        await tick(20)
    }
    return Date.now() - started
}

// A network in memory: every transport hears the others (not itself), from `host`. The probe
// connection is real TCP, so hosts must be reachable — loopback.
function network() {
    const wire = new Subject<ServiceDiscoveryMessage>()
    const join = (...hosts: string[]): ServiceDiscoveryTransport => {
        let own: string | undefined
        const heard = new Observable<ServiceDiscoveryMessage>(subscriber => wire.subscribe(message => {
            if (message.node_id !== own) subscriber.next(message)
        }))
        return Object.assign(heard, {
            async broadcast(message: ServiceDiscoveryMessage) {
                own = message.node_id
                // One copy per interface, like a real host.
                for (const host of hosts) wire.next({ ...message, remote_host: host })
            },
            close() {},
        })
    }
    return { join }
}

describe('discoverServices — connection instead of heartbeat', () => {
    test('a service is routed once the gateway is connected to it', async () => {
        const net = network()
        const directory = discoverServices({ transport: net.join('127.0.0.1') })
        const announced = await announceService({ name: 'tasks', port: 8081, prefixes: ['/livequery/tasks', '/livequery/users/:user_id/tasks'], transport: net.join('127.0.0.1') })
        await waitUntil(() => !!directory.services().tasks)
        const routing = directory.routing()
        expect(matchService(routing, '/livequery/tasks/abc')).toMatchObject({ name: 'tasks', target: { url: 'http://127.0.0.1:8081' } })
        expect(matchService(routing, '/livequery/users/u1/tasks')?.name).toBe('tasks')
        expect(matchService(routing, '/livequery/other')).toBeUndefined()
        await announced.close()
        directory.close()
    })

    test('the service closes: dropped at once, no timeout to wait for', async () => {
        const net = network()
        const directory = discoverServices({ transport: net.join('127.0.0.1') })
        const announced = await announceService({ name: 'tasks', port: 8081, prefixes: ['/livequery/tasks'], transport: net.join('127.0.0.1') })
        await waitUntil(() => !!directory.services().tasks)
        await announced.close()
        const took = await waitUntil(() => !directory.services().tasks)
        expect(took).toBeLessThan(200)
        expect(matchService(directory.routing(), '/livequery/tasks')).toBeUndefined()
        directory.close()
    })

    test('several interfaces: a VPN address is tried last, loopback first', async () => {
        const net = network()
        const directory = discoverServices({ transport: net.join('127.0.0.1') })
        // The VPN copy arrives first; the gateway still connects over loopback.
        const announced = await announceService({ name: 'tasks', port: 8081, prefixes: ['/livequery/tasks'], transport: net.join('100.65.54.48', '192.168.2.144', '127.0.0.1') })
        await waitUntil(() => !!directory.services().tasks)
        expect(directory.services()).toEqual({ tasks: ['http://127.0.0.1:8081'] })
        await announced.close()
        directory.close()
    })

    test('several interfaces: the gateway uses the address that answers, loopback first', async () => {
        const net = network()
        const directory = discoverServices({ transport: net.join('127.0.0.1') })
        // An address nothing listens on, then loopback.
        const announced = await announceService({ name: 'tasks', port: 8081, prefixes: ['/livequery/tasks'], transport: net.join('192.0.2.10', '127.0.0.1') })
        await waitUntil(() => !!directory.services().tasks)
        expect(directory.services()).toEqual({ tasks: ['http://127.0.0.1:8081'] })
        await announced.close()
        directory.close()
    })

    test('two instances share the traffic in turn', async () => {
        const net = network()
        const directory = discoverServices({ transport: net.join('127.0.0.1') })
        const a = await announceService({ name: 'tasks', url: 'http://a:1', prefixes: ['/livequery/tasks'], transport: net.join('127.0.0.1') })
        const b = await announceService({ name: 'tasks', url: 'http://b:1', prefixes: ['/livequery/tasks'], transport: net.join('127.0.0.1') })
        await waitUntil(() => directory.services().tasks?.length === 2)
        const urls = Array.from({ length: 4 }, () => matchService(directory.routing(), '/livequery/tasks')!.target.url)
        expect(new Set(urls)).toEqual(new Set(['http://a:1', 'http://b:1']))
        expect(urls[0]).not.toBe(urls[1])
        await a.close()
        await waitUntil(() => directory.services().tasks?.length === 1)
        expect(directory.services()).toEqual({ tasks: ['http://b:1'] })
        await b.close()
        directory.close()
    })

    test('unreachable(url): out at once, back when the connection is made again', async () => {
        const net = network()
        const directory = discoverServices({ transport: net.join('127.0.0.1') })
        const announced = await announceService({ name: 'tasks', port: 8081, prefixes: ['/livequery/tasks'], transport: net.join('127.0.0.1') })
        await waitUntil(() => !!directory.services().tasks)
        directory.unreachable('http://127.0.0.1:8081/livequery/tasks')
        expect(directory.services()).toEqual({})
        await waitUntil(() => !!directory.services().tasks, 3000)
        await announced.close()
        directory.close()
    })

    test('declared routing stays; services with different :param names share a segment', async () => {
        const net = network()
        const directory = discoverServices({
            transport: net.join('127.0.0.1'),
            routing: { services: { static: { url: 'http://static:9000' } }, routes: { livequery: { files: { $service: 'static' } } } },
        })
        const a = await announceService({ name: 'orders', port: 1, prefixes: ['/livequery/customers/:customer_id/orders'], transport: net.join('127.0.0.1') })
        const b = await announceService({ name: 'profile', port: 2, prefixes: ['/livequery/customers/:id/profile'], transport: net.join('127.0.0.1') })
        await waitUntil(() => Object.keys(directory.services()).length === 2)
        const routing = directory.routing()
        expect(matchService(routing, '/livequery/files/x')?.name).toBe('static')
        expect(matchService(routing, '/livequery/customers/c1/orders')?.name).toBe('orders')
        expect(matchService(routing, '/livequery/customers/c1/profile')?.name).toBe('profile')
        await a.close(); await b.close()
        directory.close()
    })

    test('prefixes from a Hono app: its /livequery routes', async () => {
        const net = network()
        const directory = discoverServices({ transport: net.join('127.0.0.1') })
        const app = { routes: [{ path: '/health' }, { path: '/livequery/tasks' }, { path: '/livequery/tasks/:id' }, { path: '/livequery/*' }] }
        const announced = await announceService({ name: 'tasks', port: 8081, app, transport: net.join('127.0.0.1') })
        await waitUntil(() => !!directory.services().tasks)
        expect(matchService(directory.routing(), '/livequery/tasks/1')?.name).toBe('tasks')
        expect(matchService(directory.routing(), '/health')).toBeUndefined()
        await announced.close()
        directory.close()
    })
})

describe('over real UDP on this machine', () => {
    const options = () => ({ key: `test-${crypto.randomUUID()}`, port: 20_000 + Math.floor(Math.random() * 10_000) })

    test('a service and a gateway find each other; closing drops it', async () => {
        const udp = options()
        const directory = discoverServices({ udp })
        const announced = await announceService({ name: 'tasks', port: 8081, prefixes: ['/livequery/tasks'], udp })
        await waitUntil(() => !!directory.services().tasks, 5000)
        expect(directory.services().tasks?.[0]).toMatch(/^http:\/\/.+:8081$/)
        await announced.close()
        await waitUntil(() => !directory.services().tasks, 1000)
        directory.close()
    }, 10_000)

    test('a gateway started later learns the service from its single announcement', async () => {
        const udp = options()
        const announced = await announceService({ name: 'tasks', port: 8081, prefixes: ['/livequery/tasks'], udp })
        await tick(500)
        const directory = discoverServices({ udp })
        await waitUntil(() => !!directory.services().tasks, 3000)
        await announced.close()
        directory.close()
    }, 10_000)

    test('a service process killed with SIGKILL is dropped at once', async () => {
        const udp = options()
        const directory = discoverServices({ udp })
        const script = `
            import { announceService } from '${new URL('../src/announceService.ts', import.meta.url).pathname}'
            await announceService({ name: 'tasks', port: 8081, prefixes: ['/livequery/tasks'], udp: ${JSON.stringify(udp)} })
            console.log('announced')
            setInterval(() => {}, 1000)
        `
        const child = Bun.spawn(['bun', '-e', script], { stdout: 'pipe', stderr: 'inherit' })
        await waitUntil(() => !!directory.services().tasks, 8000)
        child.kill('SIGKILL')
        const took = await waitUntil(() => !directory.services().tasks, 3000)
        expect(took).toBeLessThan(500)
        directory.close()
    }, 15_000)

    test('a gateway with another key sees nothing', async () => {
        const port = 20_000 + Math.floor(Math.random() * 10_000)
        const announced = await announceService({ name: 'tasks', port: 8081, prefixes: ['/livequery/tasks'], udp: { key: 'service-key', port } })
        const directory = discoverServices({ udp: { key: 'another-key', port } })
        await tick(1000)
        expect(directory.services()).toEqual({})
        await announced.close()
        directory.close()
    }, 10_000)
})
