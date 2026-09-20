/**
 * Offline-isolation behaviour of ApiGatewayHandler.
 *
 * Policy under test:
 *  - On an HTTP transport error (or a dropped WS link) the WHOLE node is isolated,
 *    so its other routes stop being dialed — *as long as a healthy alternative
 *    exists*.
 *  - A route served by a SINGLE node is never hard-failed (503): the lone node is
 *    kept in rotation even while marked offline, because there's nothing to fall
 *    back to and it may just be flapping/restarting.
 *  - Recovery: a successful response, or a fresh heartbeat, lifts HTTP isolation;
 *    WS isolation lifts only on a real WS reconnect (a heartbeat must not undo it).
 */
import { describe, expect, test } from 'bun:test'
import * as http from 'http'
import type { AddressInfo } from 'net'
import { Subject } from 'rxjs'
import { ApiGatewayHandler, WebsocketGateway, WEBSOCKET_PATH, type DiscoveryMessage, type ServiceApiMetadata } from '../src/node.js'

function createDiscovery() {
    const subject = new Subject<DiscoveryMessage<ServiceApiMetadata>>() as Subject<DiscoveryMessage<ServiceApiMetadata>> & {
        broadcast(message: DiscoveryMessage<ServiceApiMetadata>): Promise<void>
        close(): void
    }
    subject.broadcast = async () => {}
    subject.close = () => subject.complete()
    return subject
}

function startService(body: string, port = 0): Promise<{ server: http.Server; port: number }> {
    return new Promise((resolve, reject) => {
        const server = http.createServer((_q, res) => res.end(body))
        server.once('error', reject)
        server.listen(port, () => resolve({ server, port: (server.address() as AddressInfo).port }))
    })
}

const closeServer = (server: http.Server) => new Promise<void>(resolve => {
    server.closeAllConnections?.()
    server.close(() => resolve())
})
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const text = (r: Response) => r.text()

function meta(o: Partial<ServiceApiMetadata> & { node_id: string; port: number; version: number }): DiscoveryMessage<ServiceApiMetadata> {
    const { node_id, version, ...data } = o
    return {
        node_id,
        namespace: 'default',
        tags: ['livequery', 'service'],
        version: String(version),
        created_at: Date.now(),
        seq: version,
        data: {
            host: '127.0.0.1',
            role: 'service',
            name: 'svc',
            paths: [{ method: 'GET', path: 'livequery/products' }],
            linked: [],
            ...data,
        },
    }
}

async function bodiesSeen(gateway: ApiGatewayHandler, path: string, n = 6): Promise<string[]> {
    const seen = new Set<string>()
    for (let i = 0; i < n; i++) seen.add(await text(await gateway.fetch(new Request(`http://gateway/${path}`))))
    return [...seen].sort()
}

describe('ApiGatewayHandler — offline isolation', () => {
    test('an HTTP failure isolates the node across ALL its routes — traffic shifts to the healthy node', async () => {
        const gateway = new ApiGatewayHandler({ discovery: createDiscovery(), node_id: 'gateway' })
        const dead = await startService('DEAD')
        const live = await startService('LIVE')
        // both nodes serve /a and /b; 'dead' is registered first so it's dialed first
        for (const [id, port] of [['dead', dead.port], ['live', live.port]] as const) {
            gateway.register({
                node_id: id,
                hostname: '127.0.0.1',
                port,
                paths: [{ method: 'GET', path: 'livequery/a' }, { method: 'GET', path: 'livequery/b' }],
            })
        }
        await closeServer(dead.server)

        // Touch /a on the dead node → it fails and the WHOLE 'dead' node is isolated.
        const a = await gateway.fetch(new Request('http://gateway/livequery/a'))
        expect(a.status).toBe(502)

        // /b must now only ever reach 'live' — isolation covered every route of 'dead'.
        expect(await bodiesSeen(gateway, 'livequery/b')).toEqual(['LIVE'])

        gateway.close()
        await closeServer(live.server)
    })

    test('a sole node stays reachable while offline and recovers without waiting for a heartbeat', async () => {
        const gateway = new ApiGatewayHandler({ discovery: createDiscovery(), node_id: 'gateway' })
        const up = await startService('up')
        const port = up.port
        gateway.register({ node_id: 'solo', hostname: '127.0.0.1', port, paths: [{ method: 'GET', path: 'livequery/p' }] })

        expect(await text(await gateway.fetch(new Request('http://gateway/livequery/p')))).toBe('up')

        await closeServer(up.server)
        // down → 502 (marks offline) … and a sole node is never hard-503'd — keep dialing it
        expect((await gateway.fetch(new Request('http://gateway/livequery/p'))).status).toBe(502)
        expect((await gateway.fetch(new Request('http://gateway/livequery/p'))).status).toBe(502)

        // node restarts on the SAME port — no re-broadcast/heartbeat involved
        const back = await startService('back', port)
        const r = await gateway.fetch(new Request('http://gateway/livequery/p'))

        gateway.close()
        await closeServer(back.server)
        expect(r.status).toBe(200)
        expect(await text(r)).toBe('back') // recovered purely because we kept dialing it
    })

    test('with EVERY node offline the gateway keeps round-robining them (no 503) and recovers when one returns', async () => {
        const gateway = new ApiGatewayHandler({ discovery: createDiscovery(), node_id: 'gateway' })
        const a = await startService('A')
        const b = await startService('B')
        const aPort = a.port
        gateway.register({ node_id: 'a', hostname: '127.0.0.1', port: aPort, paths: [{ method: 'GET', path: 'livequery/x' }] })
        gateway.register({ node_id: 'b', hostname: '127.0.0.1', port: b.port, paths: [{ method: 'GET', path: 'livequery/x' }] })
        await closeServer(a.server)
        await closeServer(b.server)

        // All nodes down → still dialed (502), never hard-503'd.
        for (let i = 0; i < 4; i++) {
            expect((await gateway.fetch(new Request('http://gateway/livequery/x'))).status).toBe(502)
        }

        // One node comes back → round-robin finds it again and serves it.
        const a2 = await startService('A-back', aPort)
        let recovered = ''
        for (let i = 0; i < 8 && recovered !== 'A-back'; i++) {
            recovered = await text(await gateway.fetch(new Request('http://gateway/livequery/x')))
        }

        gateway.close()
        await closeServer(a2.server)
        expect(recovered).toBe('A-back')
    })

    test('a fresh heartbeat re-includes an HTTP-isolated node (with a healthy alternative present)', async () => {
        const discovery = createDiscovery()
        const gateway = new ApiGatewayHandler({ discovery, node_id: 'gateway' })
        const a = await startService('A1')
        const b = await startService('B')
        discovery.next(meta({ node_id: 'A', port: a.port, version: 1, paths: [{ method: 'GET', path: 'livequery/p' }] }))
        discovery.next(meta({ node_id: 'B', port: b.port, version: 1, paths: [{ method: 'GET', path: 'livequery/p' }] }))
        await sleep(10)

        await closeServer(a.server)
        // dial until 'A' is hit and isolated → afterwards only 'B' answers
        await bodiesSeen(gateway, 'livequery/p')
        expect(await bodiesSeen(gateway, 'livequery/p')).toEqual(['B'])

        // 'A' restarts on the same port and re-broadcasts → heartbeat lifts its HTTP isolation
        const a2 = await startService('A2', a.port)
        discovery.next(meta({ node_id: 'A', port: a.port, version: 2, paths: [{ method: 'GET', path: 'livequery/p' }] }))
        await sleep(10)

        expect(await bodiesSeen(gateway, 'livequery/p')).toEqual(['A2', 'B'])

        gateway.close()
        await closeServer(a2.server)
        await closeServer(b.server)
    })

    test('a hung upstream is cut off by the timeout (504) and the node is isolated', async () => {
        const gateway = new ApiGatewayHandler({ discovery: createDiscovery(), node_id: 'gateway', timeoutMs: 150 })
        const hung = http.createServer(() => { /* accept the request but never respond */ })
        await new Promise<void>(r => hung.listen(0, r))
        const port = (hung.address() as AddressInfo).port
        gateway.register({ node_id: 'hung', hostname: '127.0.0.1', port, paths: [{ method: 'GET', path: 'livequery/h' }] })

        const started = Date.now()
        const r = await gateway.fetch(new Request('http://gateway/livequery/h'))
        const elapsed = Date.now() - started

        gateway.close()
        ;(hung as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
        await closeServer(hung)

        expect(r.status).toBe(504)
        expect(await r.json()).toMatchObject({ error: { status: 504, code: 'SERVICE_API_TIMEOUT' } })
        expect(elapsed).toBeGreaterThanOrEqual(130) // actually waited for the timeout
        expect(elapsed).toBeLessThan(2000)          // but bounded — did NOT hang forever
    })

    test('a dropped WS isolates the node; a heartbeat does NOT bring it back (only a WS reconnect may)', async () => {
        const lws = new WebsocketGateway()
        const discovery = createDiscovery()
        const gateway = new ApiGatewayHandler({ ws: lws, discovery, node_id: 'gateway' })

        // node A: HTTP 'A' + a WS gateway on the same server. node B: HTTP only.
        const serverA = http.createServer((_q, res) => res.end('A'))
        const svcGatewayA = new WebsocketGateway(serverA)
        await new Promise<void>(r => serverA.listen(0, r))
        const portA = (serverA.address() as AddressInfo).port
        const b = await startService('B')

        discovery.next(meta({ node_id: 'A', port: portA, version: 1, paths: [{ method: 'GET', path: 'livequery/p' }], ws: { path: WEBSOCKET_PATH, auth: svcGatewayA.auth } }))
        discovery.next(meta({ node_id: 'B', port: b.port, version: 1, paths: [{ method: 'GET', path: 'livequery/p' }] }))
        await sleep(150) // let the gateway's WS bridge to A finish its start/hello handshake

        // Drop ONLY A's WS link — A's HTTP stays up — A must be isolated anyway.
        svcGatewayA.close()
        await sleep(120)
        expect(await bodiesSeen(gateway, 'livequery/p')).toEqual(['B']) // A excluded despite HTTP being up

        // A heartbeat must NOT undo WS isolation.
        discovery.next(meta({ node_id: 'A', port: portA, version: 2, paths: [{ method: 'GET', path: 'livequery/p' }], ws: { path: WEBSOCKET_PATH, auth: svcGatewayA.auth } }))
        await sleep(20)
        expect(await bodiesSeen(gateway, 'livequery/p')).toEqual(['B']) // still only B

        gateway.close()
        lws.close()
        await closeServer(serverA)
        await closeServer(b.server)
    })
})
