import { describe, expect, test } from 'bun:test'
import {
    WebsocketGatewayBase,
    type SocketLike,
    type UpdatedData,
} from '../../src/bun.js'

type Machine = {
    id: string
    online?: boolean
    progress?: number
}

function connect(
    gateway: WebsocketGatewayBase,
    clientId: string,
) {
    const sent: string[] = []
    const socket: SocketLike = {
        id: '',
        gateway: false,
        refs: new Set(),
        send(message) { sent.push(message) },
        close() {},
    }

    gateway.onConnection(socket)
    gateway.onMessage(socket, JSON.stringify({
        event: 'start',
        data: { id: clientId, auth: '' },
    }))

    return { socket, sent }
}

function subscribe(
    gateway: WebsocketGatewayBase,
    clientId: string,
    ref: string,
) {
    gateway.handle({
        request: {
            path: `/livequery/${ref}`,
            ref: `/livequery/${ref}`,
            method: 'GET',
            params: {},
            query: {},
            headers: new Map([['x-lcid', clientId]]),
        },
        livequery: {
            ref,
            keys: {},
            method: 'GET',
        },
    })
}

describe('WebsocketGatewayBase', () => {
    test('sends collection updates using the canonical sync event', async () => {
        const gateway = new WebsocketGatewayBase()
        const { sent } = connect(gateway, 'client-1')
        subscribe(gateway, 'client-1', 'projects/p1/machines')

        const change: UpdatedData<Machine> = {
            ref: 'projects/p1/machines',
            type: 'modified',
            data: { id: 'm1', online: true },
        }
        gateway.next(change)
        await Bun.sleep(5)

        expect(JSON.parse(sent.at(-1)!)).toEqual({
            event: 'sync',
            cids: ['client-1'],
            data: {
                changes: [{
                    ref: 'projects/p1/machines',
                    type: 'modified',
                    id: 'm1',
                    data: { id: 'm1', online: true },
                }],
            },
        })
        gateway.close()
    })

    test('notifies a subscriber of the matching document ref', async () => {
        const gateway = new WebsocketGatewayBase()
        const { sent } = connect(gateway, 'client-2')
        subscribe(gateway, 'client-2', 'projects/p1/machines/m1')

        const change: UpdatedData<Machine> = {
            ref: 'projects/p1/machines',
            type: 'modified',
            data: { id: 'm1', progress: 68 },
        }
        gateway.next(change)
        await Bun.sleep(5)

        expect(JSON.parse(sent.at(-1)!).data.changes[0].data.progress).toBe(68)
        gateway.close()
    })
})
