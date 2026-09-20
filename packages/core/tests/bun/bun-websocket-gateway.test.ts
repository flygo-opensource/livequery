import { describe, expect, test } from 'bun:test'
import { BunWebsocketGateway } from '../../src/bun.js'

describe('BunWebsocketGateway', () => {
    test('upgrades only the configured Livequery path', () => {
        const gateway = new BunWebsocketGateway()
        let socketData: unknown
        const server = {
            upgrade(_request: Request, options: { data: unknown }) {
                socketData = options.data
                return true
            },
        }

        expect(gateway.attachBunUpgrade(
            new Request('http://localhost/livequery/realtime-updates'),
            server as never,
        )).toBe(true)
        expect(socketData).toMatchObject({
            id: '',
            gateway: false,
            livequery: true,
        })

        expect(gateway.attachBunUpgrade(
            new Request('http://localhost/not-livequery'),
            server as never,
        )).toBe(false)
        gateway.close()
    })

    test('speaks the existing start/hello protocol', () => {
        const gateway = new BunWebsocketGateway()
        const sent: string[] = []
        const data = {
            id: '',
            gateway: false,
            refs: new Set<string>(),
            livequery: true as const,
        }
        const socket = {
            data,
            send(message: string) { sent.push(message) },
            close() {},
        }
        const handlers = gateway.getBunWebsocketHandlers()

        handlers.open(socket)
        handlers.message(socket, JSON.stringify({
            event: 'start',
            data: { id: 'client-1', auth: '' },
        }))

        expect(JSON.parse(sent[0])).toMatchObject({
            event: 'hello',
            binary: true,
        })
        expect(data.id).toBe('client-1')
        gateway.close()
    })
})
