import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
    HibernatableWebsocketGateway,
    LIVEQUERY_DO_BROADCAST_PATH,
    LIVEQUERY_DO_SUBSCRIBE_PATH,
    LIVEQUERY_PRINCIPAL_HEADER,
} from '../../src/workers.js'
import type { DurableObjectStateLike, HibernatableWebSocket } from '../../src/workers.js'

type FakeWebSocket = HibernatableWebSocket & { sent: string[]; closed: boolean; attachment: unknown }

type FakeState = DurableObjectStateLike & {
    sockets: FakeWebSocket[]
    data: Map<string, unknown>
    alarm: number | null
}

function makeSocket(): FakeWebSocket {
    const ws: FakeWebSocket = {
        readyState: 1,
        sent: [],
        closed: false,
        attachment: null,
        send(data) { ws.sent.push(data) },
        close() {
            ws.closed = true
            ;(ws as { readyState: number }).readyState = 3
        },
        serializeAttachment(value) { ws.attachment = structuredClone(value) },
        deserializeAttachment() { return structuredClone(ws.attachment) },
    }
    return ws
}

function makeState(id = 'do-1', data = new Map<string, unknown>(), sockets: FakeWebSocket[] = []): FakeState {
    const state: FakeState = {
        id: { toString: () => id },
        sockets,
        data,
        alarm: null,
        storage: {
            async list<T>({ prefix }: { prefix: string }) {
                return new Map([...data].filter(([k]) => k.startsWith(prefix))) as Map<string, T>
            },
            async put(key, value) { data.set(key, structuredClone(value)) },
            async delete(keys) {
                let n = 0
                for (const k of keys) if (data.delete(k)) n++
                return n
            },
            async getAlarm() { return state.alarm },
            async setAlarm(at) { state.alarm = at instanceof Date ? at.getTime() : at },
        },
        acceptWebSocket(ws) { sockets.push(ws as FakeWebSocket) },
        getWebSockets() { return sockets.filter(ws => !ws.closed) },
        blockConcurrencyWhile: callback => callback(),
    }
    return state
}

let pending_socket: FakeWebSocket | undefined

beforeEach(() => {
    ;(globalThis as Record<string, unknown>).WebSocketPair = class {
        0 = makeSocket()
        1 = makeSocket()
        constructor() { pending_socket = this[1] }
    }
})

afterEach(() => {
    delete (globalThis as Record<string, unknown>).WebSocketPair
})

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))

async function connect(gateway: HibernatableWebsocketGateway, client_id: string, principal?: string) {
    const headers = new Headers({ Upgrade: 'websocket' })
    if (principal !== undefined) headers.set(LIVEQUERY_PRINCIPAL_HEADER, principal)
    const response = await gateway.fetch(new Request('https://do/ws', { headers }))
    expect(response.status).toBe(101)
    const ws = pending_socket as FakeWebSocket
    gateway.webSocketMessage(ws, JSON.stringify({ event: 'start', data: { id: client_id } }))
    return ws
}

function subscribeRequest(body: object, principal?: string) {
    const headers = new Headers({ 'content-type': 'application/json' })
    if (principal !== undefined) headers.set(LIVEQUERY_PRINCIPAL_HEADER, principal)
    return new Request(`https://do${LIVEQUERY_DO_SUBSCRIBE_PATH}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    })
}

function broadcastRequest(update: object) {
    return new Request(`https://do${LIVEQUERY_DO_BROADCAST_PATH}`, { method: 'POST', body: JSON.stringify(update) })
}

function syncs(ws: FakeWebSocket) {
    return ws.sent.map(s => JSON.parse(s)).filter(m => m.event === 'sync')
}

// ─── handshake ─────────────────────────────────────────────────────────────────

describe('HibernatableWebsocketGateway handshake', () => {
    test('hello announces the Durable Object id and JSON frames', async () => {
        const gateway = new HibernatableWebsocketGateway(makeState('do-abc'))
        const ws = await connect(gateway, 'c1')
        expect(JSON.parse(ws.sent[0])).toEqual({ event: 'hello', gid: 'do-abc', binary: false })
        expect(ws.attachment).toEqual({ id: 'c1', principal: undefined })
    })

    test('start with an oversized client id — socket closed', async () => {
        const gateway = new HibernatableWebsocketGateway(makeState())
        const ws = await connect(gateway, 'x'.repeat(200))
        expect(ws.closed).toBe(true)
    })
})

// ─── subscribe and broadcast ───────────────────────────────────────────────────

describe('HibernatableWebsocketGateway subscriptions', () => {
    test('worker subscribe then broadcast — client receives sync and the record is persisted', async () => {
        const state = makeState('do-1')
        const gateway = new HibernatableWebsocketGateway(state)
        const ws = await connect(gateway, 'c1', 'alice')

        const sub = { ref: 'tasks', client_id: 'c1', gateway_id: 'do-1', listener_node_id: 'do-1' }
        expect((await gateway.fetch(subscribeRequest(sub, 'alice'))).status).toBe(204)
        expect(state.data.get('sub:c1:tasks')).toMatchObject({ ref: 'tasks', client_id: 'c1', principal: 'alice' })

        await gateway.fetch(broadcastRequest({ ref: 'tasks', type: 'added', data: { id: 't1' } }))
        await tick()
        expect(syncs(ws)).toHaveLength(1)
        expect(syncs(ws)[0].data.changes[0]).toMatchObject({ ref: 'tasks', id: 't1' })
    })

    test('subscribe from another principal — rejected with 403', async () => {
        const gateway = new HibernatableWebsocketGateway(makeState('do-1'))
        await connect(gateway, 'c1', 'alice')
        const sub = { ref: 'tasks', client_id: 'c1', gateway_id: 'do-1', listener_node_id: 'do-1' }
        expect((await gateway.fetch(subscribeRequest(sub, 'mallory'))).status).toBe(403)
        expect((await gateway.fetch(subscribeRequest(sub))).status).toBe(403)
    })

    test('subscribe for another gateway or an unknown client — rejected', async () => {
        const gateway = new HibernatableWebsocketGateway(makeState('do-1'))
        await connect(gateway, 'c1')
        expect(gateway.register({ ref: 'tasks', client_id: 'c1', gateway_id: 'do-2', listener_node_id: 'do-2' }))
            .toBe(false)
        expect(gateway.register({ ref: 'tasks', client_id: 'nobody', gateway_id: 'do-1', listener_node_id: 'do-1' }))
            .toBe(false)
    })

    test('client subscribe frame — ignored', async () => {
        const gateway = new HibernatableWebsocketGateway(makeState('do-1'))
        const ws = await connect(gateway, 'c1')
        gateway.webSocketMessage(ws, JSON.stringify({
            event: 'subscribe', ref: 'secrets', client_id: 'c1', gateway_id: 'do-1', listener_node_id: 'do-1',
        }))
        gateway.next({ ref: 'secrets', type: 'added', data: { id: 's1' } })
        await tick()
        expect(syncs(ws)).toHaveLength(0)
    })

    test('client unsubscribe naming another client — only drops its own subscription', async () => {
        const state = makeState('do-1')
        const gateway = new HibernatableWebsocketGateway(state)
        const victim = await connect(gateway, 'victim')
        const attacker = await connect(gateway, 'attacker')
        gateway.register({ ref: 'tasks', client_id: 'victim', gateway_id: 'do-1', listener_node_id: 'do-1' })
        gateway.register({ ref: 'tasks', client_id: 'attacker', gateway_id: 'do-1', listener_node_id: 'do-1' })

        gateway.webSocketMessage(attacker, JSON.stringify({
            event: 'unsubscribe', data: { ref: 'tasks', client_id: 'victim' },
        }))
        gateway.next({ ref: 'tasks', type: 'added', data: { id: 't1' } })
        await tick()

        expect(syncs(victim)).toHaveLength(1)
        expect(syncs(attacker)).toHaveLength(0)
        expect(state.data.has('sub:victim:tasks')).toBe(true)
        expect(state.data.has('sub:attacker:tasks')).toBe(false)
    })

    test('start with a client id owned by another principal — socket closed', async () => {
        const gateway = new HibernatableWebsocketGateway(makeState('do-1'), { disconnectGraceMs: 1000 })
        const first = await connect(gateway, 'c1', 'alice')
        gateway.register({ ref: 'tasks', client_id: 'c1', gateway_id: 'do-1', listener_node_id: 'do-1' }, 'alice')
        gateway.webSocketClose(first)

        const hijack = await connect(gateway, 'c1', 'mallory')
        expect(hijack.closed).toBe(true)
        gateway.close()
    })
})

// ─── hibernation ───────────────────────────────────────────────────────────────

describe('HibernatableWebsocketGateway hibernation', () => {
    test('woken instance restores sockets and subscriptions and keeps delivering', async () => {
        const data = new Map<string, unknown>()
        const sockets: FakeWebSocket[] = []
        const before = new HibernatableWebsocketGateway(makeState('do-1', data, sockets))
        const ws = await connect(before, 'c1', 'alice')
        before.register({ ref: 'tasks', client_id: 'c1', gateway_id: 'do-1', listener_node_id: 'do-1' }, 'alice')

        // Eviction: the instance is gone, storage and accepted sockets survive.
        const after = new HibernatableWebsocketGateway(makeState('do-1', data, sockets))
        await after.ready
        expect(after.id).toBe(before.id)

        await after.fetch(broadcastRequest({ ref: 'tasks', type: 'modified', data: { id: 't1' } }))
        await tick()
        expect(syncs(ws)).toHaveLength(1)

        // Socket identity survives too: the restored socket can unsubscribe itself.
        after.webSocketMessage(ws, JSON.stringify({ event: 'unsubscribe', data: { ref: 'tasks' } }))
        expect(data.has('sub:c1:tasks')).toBe(false)
    })

    test('subscription whose socket vanished while evicted — kept until the alarm fires', async () => {
        const data = new Map<string, unknown>([
            ['sub:gone:tasks', { ref: 'tasks', client_id: 'gone', gateway_id: 'do-1', listener_node_id: 'do-1' }],
        ])
        const state = makeState('do-1', data)
        const gateway = new HibernatableWebsocketGateway(state, { disconnectGraceMs: 10 })
        await gateway.ready

        // Restoring only arms the alarm; the record survives in case the client is reconnecting.
        expect(data.has('sub:gone:tasks')).toBe(true)
        expect(state.alarm).not.toBeNull()

        await tick(20)
        await gateway.alarm()
        expect(data.has('sub:gone:tasks')).toBe(false)
        expect(data.has('expire:gone')).toBe(false)
    })

    test('client reconnecting before the alarm — keeps its subscriptions', async () => {
        const data = new Map<string, unknown>([
            ['sub:c1:tasks', { ref: 'tasks', client_id: 'c1', gateway_id: 'do-1', listener_node_id: 'do-1' }],
        ])
        const gateway = new HibernatableWebsocketGateway(makeState('do-1', data), { disconnectGraceMs: 10 })
        const ws = await connect(gateway, 'c1')
        await tick(20)
        await gateway.alarm()
        expect(data.has('sub:c1:tasks')).toBe(true)

        gateway.next({ ref: 'tasks', type: 'added', data: { id: 't1' } })
        await tick()
        expect(syncs(ws)).toHaveLength(1)
    })
})

// ─── alarms ────────────────────────────────────────────────────────────────────

describe('HibernatableWebsocketGateway alarms', () => {
    test('a closed socket arms an alarm; the alarm detaches after the grace window', async () => {
        const state = makeState('do-1')
        const gateway = new HibernatableWebsocketGateway(state, { disconnectGraceMs: 10 })
        const ws = await connect(gateway, 'c1')
        gateway.register({ ref: 'tasks', client_id: 'c1', gateway_id: 'do-1', listener_node_id: 'do-1' })

        gateway.webSocketClose(ws)
        await tick()
        expect(state.alarm).not.toBeNull()
        expect(state.data.has('sub:c1:tasks')).toBe(true)     // kept during the grace window

        await tick(20)
        await gateway.alarm()
        expect(state.data.has('sub:c1:tasks')).toBe(false)
        expect(state.data.has('expire:c1')).toBe(false)
    })

    test('an alarm that fires early keeps the subscription and re-arms', async () => {
        const state = makeState('do-1')
        const gateway = new HibernatableWebsocketGateway(state, { disconnectGraceMs: 10_000 })
        const ws = await connect(gateway, 'c1')
        gateway.register({ ref: 'tasks', client_id: 'c1', gateway_id: 'do-1', listener_node_id: 'do-1' })
        gateway.webSocketClose(ws)
        await tick()

        await gateway.alarm()
        expect(state.data.has('sub:c1:tasks')).toBe(true)
        expect(state.alarm).not.toBeNull()
    })

    test('a client that reconnects before the alarm clears its expiry', async () => {
        const state = makeState('do-1')
        const gateway = new HibernatableWebsocketGateway(state, { disconnectGraceMs: 10_000 })
        const first = await connect(gateway, 'c1')
        gateway.register({ ref: 'tasks', client_id: 'c1', gateway_id: 'do-1', listener_node_id: 'do-1' })
        gateway.webSocketClose(first)
        await tick()
        expect(state.data.has('expire:c1')).toBe(true)

        const second = await connect(gateway, 'c1')
        await tick()
        expect(state.data.has('expire:c1')).toBe(false)

        gateway.next({ ref: 'tasks', type: 'added', data: { id: 't1' } })
        await tick()
        expect(syncs(second)).toHaveLength(1)                 // subscriptions resumed, no re-query
    })

    test('the alarm re-arms a sweep while subscriptions remain', async () => {
        const state = makeState('do-1')
        const gateway = new HibernatableWebsocketGateway(state)
        await connect(gateway, 'c1')
        gateway.register({ ref: 'tasks', client_id: 'c1', gateway_id: 'do-1', listener_node_id: 'do-1' })

        state.alarm = null
        await gateway.alarm()
        expect(state.alarm).not.toBeNull()
    })
})
