import { describe, expect, test } from 'bun:test'
import * as http from 'http'
import type { AddressInfo } from 'net'
import { of } from 'rxjs'
import { WebSocket } from 'ws'
import { WEBSOCKET_PATH, WebsocketGateway } from '../src/index.js'

describe('WebsocketGateway', () => {
    test('close shuts down active websocket connections', async () => {
        const { server, gateway, port } = await startGateway()
        const ws = new WebSocket(`ws://127.0.0.1:${port}${WEBSOCKET_PATH}`)

        await once(ws, 'open')
        const closed = once(ws, 'close')
        gateway.close()

        await closed
        await closeServer(server)
        expect(ws.readyState).toBe(WebSocket.CLOSED)
    })

    test('sends hello after a client starts a websocket session', async () => {
        const { server, gateway, port } = await startGateway()
        const ws = new WebSocket(`ws://127.0.0.1:${port}${WEBSOCKET_PATH}`)

        await once(ws, 'open')
        ws.send(JSON.stringify({ event: 'start', data: { id: 'client-1', auth: '' } }))

        const hello = await nextJson(ws)

        ws.close()
        gateway.close()
        await closeServer(server)
        expect(hello).toEqual({ event: 'hello', gid: gateway.id, binary: true })
    })

    test('closes a socket that starts with invalid gateway auth', async () => {
        const { server, gateway, port } = await startGateway()
        const ws = new WebSocket(`ws://127.0.0.1:${port}${WEBSOCKET_PATH}`)

        await once(ws, 'open')
        const closed = once(ws, 'close')
        ws.send(JSON.stringify({ event: 'start', data: { id: 'gateway-1', auth: 'wrong-auth' } }))

        await closed
        gateway.close()
        await closeServer(server)
        expect(ws.readyState).toBe(WebSocket.CLOSED)
    })

    test('closes the second socket when a client id is already connected', async () => {
        const { server, gateway, port } = await startGateway()
        const first = new WebSocket(`ws://127.0.0.1:${port}${WEBSOCKET_PATH}`)

        await once(first, 'open')
        first.send(JSON.stringify({ event: 'start', data: { id: 'client-1', auth: '' } }))
        await nextJson(first)

        const second = new WebSocket(`ws://127.0.0.1:${port}${WEBSOCKET_PATH}`)
        await once(second, 'open')
        const closed = once(second, 'close')
        second.send(JSON.stringify({ event: 'start', data: { id: 'client-1', auth: '' } }))

        await closed
        const firstState = first.readyState

        first.close()
        gateway.close()
        await closeServer(server)
        expect(firstState).toBe(WebSocket.OPEN)
        expect(second.readyState).toBe(WebSocket.CLOSED)
    })

    test('sends sync updates to a subscribed client', async () => {
        const { server, gateway, port } = await startGateway()
        const ws = new WebSocket(`ws://127.0.0.1:${port}${WEBSOCKET_PATH}`)

        await startClient(ws, 'client-1')
        ws.send(JSON.stringify({
            event: 'subscribe',
            ref: 'posts',
            client_id: 'client-1',
            gateway_id: gateway.id,
            listener_node_id: gateway.id,
        }))
        await sleep(10)
        gateway.next({
            ref: 'posts',
            type: 'added',
            data: { id: 'p1', title: 'Hello' },
        } as any)

        const sync = await nextJson(ws)

        ws.close()
        gateway.close()
        await closeServer(server)
        expect(sync).toEqual({
            event: 'sync',
            cids: ['client-1'],
            data: {
                changes: [{
                    ref: 'posts',
                    type: 'added',
                    data: { id: 'p1', title: 'Hello' },
                }],
            },
        })
    })

    test('sends collection updates to document subscribers', async () => {
        const { server, gateway, port } = await startGateway()
        const ws = new WebSocket(`ws://127.0.0.1:${port}${WEBSOCKET_PATH}`)

        await startClient(ws, 'client-1')
        ws.send(JSON.stringify({
            event: 'subscribe',
            ref: 'posts/p1',
            client_id: 'client-1',
            gateway_id: gateway.id,
            listener_node_id: gateway.id,
        }))
        await sleep(10)
        gateway.next({
            ref: 'posts',
            type: 'modified',
            data: { id: 'p1', title: 'Updated' },
        } as any)

        const sync = await nextJson(ws)

        ws.close()
        gateway.close()
        await closeServer(server)
        expect(sync).toEqual({
            event: 'sync',
            cids: ['client-1'],
            data: {
                changes: [{
                    ref: 'posts',
                    type: 'modified',
                    data: { id: 'p1', title: 'Updated' },
                }],
            },
        })
    })

    test('unsubscribe stops later sync updates for that ref', async () => {
        const { server, gateway, port } = await startGateway()
        const ws = new WebSocket(`ws://127.0.0.1:${port}${WEBSOCKET_PATH}`)

        await startClient(ws, 'client-1')
        ws.send(JSON.stringify({
            event: 'subscribe',
            ref: 'posts',
            client_id: 'client-1',
            gateway_id: gateway.id,
            listener_node_id: gateway.id,
        }))
        await sleep(10)
        gateway.next({
            ref: 'posts',
            type: 'added',
            data: { id: 'p1' },
        } as any)
        expect(await nextJson(ws)).toMatchObject({ event: 'sync' })

        ws.send(JSON.stringify({
            event: 'unsubscribe',
            data: { ref: 'posts', client_id: 'client-1' },
        }))
        await sleep(10)
        gateway.next({
            ref: 'posts',
            type: 'added',
            data: { id: 'p2' },
        } as any)

        await expectNoMessage(ws)
        ws.close()
        gateway.close()
        await closeServer(server)
    })

    test('handle registers a livequery context as a realtime subscription', async () => {
        const { server, gateway, port } = await startGateway()
        const ws = new WebSocket(`ws://127.0.0.1:${port}${WEBSOCKET_PATH}`)

        await startClient(ws, 'client-1')
        gateway.handle({
            request: {
                path: '/livequery/posts',
                ref: '/livequery/posts',
                method: 'GET',
                body: undefined,
                params: {},
                query: {},
                headers: new Map([['x-lcid', 'client-1']]),
            },
            livequery: {
                ref: 'posts',
                collection_ref: 'posts',
                schema_collection_ref: 'posts',
                document_id: undefined,
                keys: {},
                method: 'GET',
                path: '/livequery/posts',
                query: {},
                body: undefined,
            },
        })
        gateway.next({
            ref: 'posts',
            type: 'added',
            data: { id: 'p1' },
        } as any)

        const sync = await nextJson(ws)

        ws.close()
        gateway.close()
        await closeServer(server)
        expect(sync).toMatchObject({
            event: 'sync',
            cids: ['client-1'],
        })
    })

    test('ignores malformed JSON messages and keeps the socket usable', async () => {
        const { server, gateway, port } = await startGateway()
        const ws = new WebSocket(`ws://127.0.0.1:${port}${WEBSOCKET_PATH}`)

        await startClient(ws, 'client-1')
        ws.send('{not-json')
        ws.send(JSON.stringify({
            event: 'subscribe',
            ref: 'posts',
            client_id: 'client-1',
            gateway_id: gateway.id,
            listener_node_id: gateway.id,
        }))
        await sleep(10)
        gateway.next({
            ref: 'posts',
            type: 'added',
            data: { id: 'p1' },
        } as any)

        const sync = await nextJson(ws)

        ws.close()
        gateway.close()
        await closeServer(server)
        expect(sync).toMatchObject({
            event: 'sync',
            cids: ['client-1'],
        })
    })

    test('ignores subscribe messages sent before start', async () => {
        const { server, gateway, port } = await startGateway()
        const ws = new WebSocket(`ws://127.0.0.1:${port}${WEBSOCKET_PATH}`)

        await once(ws, 'open')
        ws.send(JSON.stringify({
            event: 'subscribe',
            ref: 'posts',
            client_id: 'client-1',
            gateway_id: gateway.id,
            listener_node_id: gateway.id,
        }))
        await sleep(10)
        ws.send(JSON.stringify({ event: 'start', data: { id: 'client-1', auth: '' } }))
        await nextJson(ws)
        gateway.next({
            ref: 'posts',
            type: 'added',
            data: { id: 'p1' },
        } as any)

        await expectNoMessage(ws)
        ws.close()
        gateway.close()
        await closeServer(server)
    })

    test('ignores listen events where the client id equals the gateway id', async () => {
        const { server, gateway, port } = await startGateway()
        const ws = new WebSocket(`ws://127.0.0.1:${port}${WEBSOCKET_PATH}`)

        await startClient(ws, 'client-1')
        gateway.listen([{
            ref: 'posts',
            client_id: 'client-1',
            gateway_id: 'client-1',
            listener_node_id: gateway.id,
        }])
        gateway.next({
            ref: 'posts',
            type: 'added',
            data: { id: 'p1' },
        } as any)

        await expectNoMessage(ws)
        ws.close()
        gateway.close()
        await closeServer(server)
    })

    test('link streams observable updates to subscribed clients', async () => {
        const { server, gateway, port } = await startGateway()
        const ws = new WebSocket(`ws://127.0.0.1:${port}${WEBSOCKET_PATH}`)

        await startClient(ws, 'client-1')
        ws.send(JSON.stringify({
            event: 'subscribe',
            ref: 'posts',
            client_id: 'client-1',
            gateway_id: gateway.id,
            listener_node_id: gateway.id,
        }))
        await sleep(10)
        await gateway.link('posts', () => of({
            ref: 'posts',
            type: 'added',
            data: { id: 'p1', title: 'Linked' },
        } as any))

        const sync = await nextJson(ws)

        ws.close()
        gateway.close()
        await closeServer(server)
        expect(sync).toEqual({
            event: 'sync',
            cids: ['client-1'],
            data: {
                changes: [{
                    ref: 'posts',
                    type: 'added',
                    data: { id: 'p1', title: 'Linked' },
                }],
            },
        })
    })

    test('disconnecting a client removes its subscriptions', async () => {
        const { server, gateway, port } = await startGateway()
        const ws = new WebSocket(`ws://127.0.0.1:${port}${WEBSOCKET_PATH}`)

        await startClient(ws, 'client-1')
        ws.send(JSON.stringify({
            event: 'subscribe',
            ref: 'posts',
            client_id: 'client-1',
            gateway_id: gateway.id,
            listener_node_id: gateway.id,
        }))
        await sleep(10)
        const closed = once(ws, 'close')
        ws.close()
        await closed
        await sleep(10)

        const replacement = new WebSocket(`ws://127.0.0.1:${port}${WEBSOCKET_PATH}`)
        await startClient(replacement, 'client-1')
        gateway.next({
            ref: 'posts',
            type: 'added',
            data: { id: 'p1' },
        } as any)

        await expectNoMessage(replacement)
        replacement.close()
        gateway.close()
        await closeServer(server)
    })

    test('close is idempotent', async () => {
        const { server, gateway } = await startGateway()

        gateway.close()
        gateway.close()

        await closeServer(server)
        expect(() => gateway.close()).not.toThrow()
    })

    test('bridges sync updates from a connected remote gateway to a local client', async () => {
        const local = await startGateway()
        const remote = await startGateway()
        const bridge = local.gateway.connect(
            `ws://127.0.0.1:${remote.port}${WEBSOCKET_PATH}`,
            remote.gateway.auth
        )
        const client = new WebSocket(`ws://127.0.0.1:${local.port}${WEBSOCKET_PATH}`)

        await startClient(client, 'client-1')
        await sleep(100)
        remote.gateway.handle({
            request: {
                path: '/livequery/posts',
                ref: '/livequery/posts',
                method: 'GET',
                body: undefined,
                params: {},
                query: {},
                headers: new Map([
                    ['x-lcid', 'client-1'],
                    ['x-lgid', local.gateway.id],
                ]),
            },
            livequery: {
                ref: 'posts',
                collection_ref: 'posts',
                schema_collection_ref: 'posts',
                document_id: undefined,
                keys: {},
                method: 'GET',
                path: '/livequery/posts',
                query: {},
                body: undefined,
            },
        })
        await sleep(10)
        remote.gateway.next({
            ref: 'posts',
            type: 'added',
            data: { id: 'p1', title: 'Remote' },
        } as any)

        const sync = await nextJson(client, 2_000)

        bridge.unsubscribe()
        client.close()
        local.gateway.close()
        remote.gateway.close()
        await Promise.all([closeServer(local.server), closeServer(remote.server)])
        expect(sync).toEqual({
            event: 'sync',
            data: {
                changes: [{
                    ref: 'posts',
                    type: 'added',
                    data: { id: 'p1', title: 'Remote' },
                }],
            },
        })
    })
})

async function startGateway(): Promise<{ server: http.Server; gateway: WebsocketGateway; port: number }> {
    const server = http.createServer()
    const gateway = new WebsocketGateway(server)
    await listen(server)
    return { server, gateway, port: (server.address() as AddressInfo).port }
}

function listen(server: http.Server): Promise<void> {
    return new Promise(resolve => server.listen(0, resolve))
}

function closeServer(server: http.Server): Promise<void> {
    return new Promise(resolve => {
        server.closeAllConnections?.()
        server.close(() => resolve())
        setTimeout(resolve, 50)
    })
}

function once(ws: WebSocket, event: 'open' | 'close'): Promise<void> {
    return new Promise((resolve, reject) => {
        ws.once(event, () => resolve())
        ws.once('error', reject)
    })
}

async function startClient(ws: WebSocket, id: string): Promise<void> {
    await once(ws, 'open')
    ws.send(JSON.stringify({ event: 'start', data: { id, auth: '' } }))
    await nextJson(ws)
}

function nextJson(ws: WebSocket, timeoutMs = 1_000): Promise<any> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup()
            reject(new Error('Timed out waiting for websocket message'))
        }, timeoutMs)
        const onMessage = (raw: Buffer) => {
            cleanup()
            resolve(JSON.parse(raw.toString()))
        }
        const onError = (error: Error) => {
            cleanup()
            reject(error)
        }
        const cleanup = () => {
            clearTimeout(timeout)
            ws.off('message', onMessage)
            ws.off('error', onError)
        }
        ws.once('message', onMessage)
        ws.once('error', onError)
    })
}

function expectNoMessage(ws: WebSocket, timeoutMs = 100): Promise<void> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup()
            resolve()
        }, timeoutMs)
        const onMessage = (raw: Buffer) => {
            cleanup()
            reject(new Error(`Unexpected websocket message: ${raw.toString()}`))
        }
        const onError = (error: Error) => {
            cleanup()
            reject(error)
        }
        const cleanup = () => {
            clearTimeout(timeout)
            ws.off('message', onMessage)
            ws.off('error', onError)
        }
        ws.once('message', onMessage)
        ws.once('error', onError)
    })
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}
