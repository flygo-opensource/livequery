import { describe, it, expect, beforeEach } from 'bun:test'
import { LivequeryWebsocketSync, WebsocketWithMetadata } from '../src/LivequeryWebsocketSync.js'

function makeMockSocket(overrides: Partial<WebsocketWithMetadata> = {}): WebsocketWithMetadata & { sent: string[] } {
    const sent: string[] = []
    return {
        id: '',
        gateway: false,
        refs: new Set(),
        send(data: string) { sent.push(data) },
        close() {},
        sent,
        ...overrides
    }
}

describe('LivequeryWebsocketSync', () => {
    let sync: LivequeryWebsocketSync

    beforeEach(() => {
        sync = new LivequeryWebsocketSync()
    })

    describe('handleOpen', () => {
        it('adds metadata fields to socket', () => {
            const rawSocket = { send() {}, close() {} }
            const ws = sync.handleOpen(rawSocket)
            expect(ws.id).toBe('')
            expect(ws.gateway).toBe(false)
            expect(ws.refs).toBeInstanceOf(Set)
        })
    })

    describe('handleMessage - start event', () => {
        it('registers socket on valid start', () => {
            const ws = makeMockSocket()
            sync.handleMessage(ws, JSON.stringify({
                event: 'start',
                data: { id: 'client-1', auth: '' }
            }))
            expect(ws.id).toBe('client-1')
            const hello = JSON.parse(ws.sent[0])
            expect(hello.event).toBe('hello')
            expect(typeof hello.gid).toBe('string')
        })

        it('closes socket on wrong auth', () => {
            let closed = false
            const ws = makeMockSocket({ close() { closed = true } })
            sync.handleMessage(ws, JSON.stringify({
                event: 'start',
                data: { id: 'client-1', auth: 'wrong-auth' }
            }))
            expect(closed).toBe(true)
        })

        it('closes duplicate connection', () => {
            const ws1 = makeMockSocket()
            sync.handleMessage(ws1, JSON.stringify({ event: 'start', data: { id: 'dup', auth: '' } }))

            let closed = false
            const ws2 = makeMockSocket({ close() { closed = true } })
            sync.handleMessage(ws2, JSON.stringify({ event: 'start', data: { id: 'dup', auth: '' } }))
            expect(closed).toBe(true)
        })
    })

    describe('listen + realtime broadcast', () => {
        it('registers subscription and delivers sync event', async () => {
            const ws = makeMockSocket()
            sync.handleMessage(ws, JSON.stringify({ event: 'start', data: { id: 'client-1', auth: '' } }))

            sync.listen([{
                ref: 'posts',
                client_id: 'client-1',
                gateway_id: sync.id,
                listener_node_id: sync.id
            }])

            sync.next({ ref: 'posts', data: { id: 'p1', title: 'Hi' } as any, type: 'added' })

            await new Promise(r => setTimeout(r, 10))

            const syncEvents = ws.sent.slice(1).map(s => JSON.parse(s))
            expect(syncEvents.some(e => e.event === 'sync')).toBe(true)
        })

        it('skips self-subscription (client_id == gateway_id)', () => {
            const before = sync['_LivequeryWebsocketSync__subscriptions' as any]?.size ?? 0
            sync.listen([{
                ref: 'posts',
                client_id: 'same',
                gateway_id: 'same',
                listener_node_id: sync.id
            }])
            expect((sync as any)['#subscriptions']?.size ?? 0).toBe(before)
        })
    })

    describe('handleMessage - unsubscribe event', () => {
        it('removes subscription on unsubscribe', async () => {
            const ws = makeMockSocket()
            sync.handleMessage(ws, JSON.stringify({ event: 'start', data: { id: 'c1', auth: '' } }))

            sync.listen([{
                ref: 'posts',
                client_id: 'c1',
                gateway_id: sync.id,
                listener_node_id: sync.id
            }])

            sync.handleMessage(ws, JSON.stringify({
                event: 'unsubscribe',
                data: { ref: 'posts', client_id: 'c1' }
            }))

            const countBefore = ws.sent.length
            sync.next({ ref: 'posts', data: { id: 'p1' } as any, type: 'added' })
            await new Promise(r => setTimeout(r, 10))

            expect(ws.sent.length).toBe(countBefore)
        })
    })

    describe('handleClose', () => {
        it('cleans up subscriptions when client disconnects', async () => {
            const ws = makeMockSocket()
            sync.handleMessage(ws, JSON.stringify({ event: 'start', data: { id: 'c1', auth: '' } }))

            sync.listen([{
                ref: 'posts',
                client_id: 'c1',
                gateway_id: sync.id,
                listener_node_id: sync.id
            }])

            sync.handleClose(ws)

            const countBefore = ws.sent.length
            sync.next({ ref: 'posts', data: { id: 'p1' } as any, type: 'added' })
            await new Promise(r => setTimeout(r, 10))

            expect(ws.sent.length).toBe(countBefore)
        })
    })

    describe('createBunHandlers', () => {
        it('returns fetch and websocket handlers', () => {
            const handlers = sync.createBunHandlers()
            expect(typeof handlers.fetch).toBe('function')
            expect(typeof handlers.websocket.open).toBe('function')
            expect(typeof handlers.websocket.message).toBe('function')
            expect(typeof handlers.websocket.close).toBe('function')
        })

        it('fetch returns undefined for the WS path (upgrade attempted)', () => {
            const handlers = sync.createBunHandlers('/livequery/realtime-updates')
            const server = { upgrade: (_: Request) => true }
            const req = new Request('http://localhost/livequery/realtime-updates')
            const result = handlers.fetch(req, server)
            expect(result).toBeUndefined()
        })

        it('fetch skips non-matching paths', () => {
            const handlers = sync.createBunHandlers('/livequery/realtime-updates')
            const server = { upgrade: (_: Request) => true }
            const req = new Request('http://localhost/other')
            const result = handlers.fetch(req, server)
            expect(result).toBeUndefined()
        })
    })
})
