import { describe, it, expect, afterEach } from 'bun:test'
import { LivequeryWebsocketSync } from '../src/LivequeryWebsocketSync.js'

describe('LivequeryWebsocketSync.startServer', () => {
    const servers: Array<{ close(): void }> = []

    afterEach(async () => {
        for (const s of servers) s.close()
        servers.length = 0
    })

    it('starts a WebSocket server and accepts connections', async () => {
        const sync = new LivequeryWebsocketSync()
        const server = await sync.startServer(47201)
        servers.push(server)

        const ws = new WebSocket('ws://localhost:47201/livequery/realtime-updates')
        const msg = await new Promise<string>((resolve, reject) => {
            ws.onmessage = e => resolve(e.data)
            ws.onerror = reject
            ws.onopen = () => ws.send(JSON.stringify({ event: 'start', data: { id: 'test-client', auth: '' } }))
        })

        const parsed = JSON.parse(msg)
        expect(parsed.event).toBe('hello')
        expect(typeof parsed.gid).toBe('string')
        ws.close()
    })

    it('uses the custom path when provided', async () => {
        const sync = new LivequeryWebsocketSync()
        const server = await sync.startServer(47202, '/custom-ws')
        servers.push(server)

        const ws = new WebSocket('ws://localhost:47202/custom-ws')
        const connected = await new Promise<boolean>((resolve, reject) => {
            ws.onopen = () => resolve(true)
            ws.onerror = () => resolve(false)
        })

        expect(connected).toBe(true)
        ws.close()
    })

    it('server.close() stops the server', async () => {
        const sync = new LivequeryWebsocketSync()
        const server = await sync.startServer(47203)
        server.close()

        await new Promise(r => setTimeout(r, 50))

        const connected = await new Promise<boolean>(resolve => {
            try {
                const ws = new WebSocket('ws://localhost:47203/livequery/realtime-updates')
                ws.onopen = () => { ws.close(); resolve(true) }
                ws.onerror = () => resolve(false)
            } catch {
                resolve(false)
            }
        })

        expect(connected).toBe(false)
    })
})
