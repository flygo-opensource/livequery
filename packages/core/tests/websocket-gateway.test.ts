import { describe, expect, test } from 'bun:test'
import * as http from 'http'
import type { AddressInfo } from 'net'
import { WebSocket } from 'ws'
import { WEBSOCKET_PATH, WebsocketGateway } from '../src/index.js'

describe('WebsocketGateway', () => {
    test('close shuts down active websocket connections', async () => {
        const server = http.createServer()
        await listen(server)
        const gateway = new WebsocketGateway(server)
        const port = (server.address() as AddressInfo).port
        const ws = new WebSocket(`ws://127.0.0.1:${port}${WEBSOCKET_PATH}`)

        await once(ws, 'open')
        const closed = once(ws, 'close')
        gateway.close()

        await closed
        await closeServer(server)
        expect(ws.readyState).toBe(WebSocket.CLOSED)
    })
})

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
