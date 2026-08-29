import { afterEach, describe, expect, test } from 'bun:test'
import { createHmac } from 'crypto'
import { createSocket } from 'dgram'
import { pack } from 'msgpackr'
import { filter, firstValueFrom, timeout } from 'rxjs'
import {
    UdpDiscovery,
    type DiscoveryMessage,
    type UdpDiscoveryOptions,
    type UdpDiscoveryPacket,
} from '../src/index.js'

type Metadata = {
    role: 'gateway' | 'service'
    name: string
}

const discoveries: UdpDiscovery<Metadata>[] = []

afterEach(() => {
    for (const discovery of discoveries.splice(0)) {
        discovery.close()
    }
})

describe('UdpDiscovery', () => {
    test('emits a signed Ohayo discovery message with the expected namespace and tags', async () => {
        const port = randomPort()
        const receiver = createDiscovery('secret', { port, node_id: 'receiver' })
        await waitReady(receiver)
        const raw = createRawPacket('secret', message({ node_id: 'sender', seq: 1 }))

        const receivedP = nextMessage(receiver)
        await sendRaw(raw, port)

        const received = await receivedP
        expect(received).toMatchObject({
            node_id: 'sender',
            namespace: 'test',
            tags: ['livequery', 'service'],
            seq: 1,
            data: { role: 'service', name: 'posts' },
            remote_host: '127.0.0.1',
        })
    })

    test('broadcast sends a signed packet to an explicit IP', async () => {
        const port = randomPort()
        const receiver = createDiscovery('secret', { port, node_id: 'receiver' })
        const sender = createDiscovery('secret', { port, node_id: 'sender' })
        await Promise.all([waitReady(receiver), waitReady(sender)])

        const receivedP = firstValueFrom(receiver.pipe(
            filter(event => event.node_id === 'sender'),
            timeout({ first: 2_000 }),
        ))
        await sender.broadcast(message({ node_id: 'sender', seq: 1 }), '127.0.0.1')

        expect(await receivedP).toMatchObject({
            node_id: 'sender',
            data: { name: 'posts' },
        })
    })

    test('rejects packets signed with a different shared key', async () => {
        const port = randomPort()
        const receiver = createDiscovery('secret-a', { port, node_id: 'receiver' })
        await waitReady(receiver)

        let received = false
        receiver.subscribe(() => { received = true })

        await sendRaw(createRawPacket('secret-b', message({ node_id: 'sender', seq: 1 })), port)
        await sleep(250)

        expect(received).toBe(false)
    })

    test('filters inbound messages by namespace and contains-all tags', async () => {
        const port = randomPort()
        const receiver = createDiscovery('secret', {
            port,
            node_id: 'receiver',
            tags: ['livequery', 'service'],
        })
        await waitReady(receiver)

        let count = 0
        receiver.subscribe(() => { count++ })

        await sendRaw(createRawPacket('secret', message({ node_id: 'sender-1', namespace: 'other', seq: 1 })), port)
        await sendRaw(createRawPacket('secret', message({ node_id: 'sender-2', tags: ['livequery'], seq: 1 })), port)
        await sendRaw(createRawPacket('secret', message({ node_id: 'sender-3', tags: ['livequery', 'service', 'prod'], seq: 1 })), port)
        await sleep(250)

        expect(count).toBe(1)
    })

    test('rejects outbound messages that do not match constructor options', async () => {
        const port = randomPort()
        const discovery = createDiscovery('secret', {
            port,
            node_id: 'sender',
            tags: ['livequery', 'service'],
        })
        await waitReady(discovery)

        await expect(discovery.broadcast(message({ node_id: 'other', seq: 1 }), '127.0.0.1')).rejects.toThrow('node_id')
        await expect(discovery.broadcast(message({ node_id: 'sender', namespace: 'other', seq: 1 }), '127.0.0.1')).rejects.toThrow('namespace')
        await expect(discovery.broadcast(message({ node_id: 'sender', tags: ['livequery'], seq: 1 }), '127.0.0.1')).rejects.toThrow('tags')
    })

    test('emits duplicate valid packets and leaves dedupe to consumers', async () => {
        const port = randomPort()
        const receiver = createDiscovery('secret', { port, node_id: 'receiver' })
        await waitReady(receiver)
        const raw = createRawPacket('secret', message({ node_id: 'sender', seq: 1 }))

        let count = 0
        receiver.subscribe(() => { count++ })

        await sendRaw(raw, port)
        await sendRaw(raw, port)
        await sleep(250)

        expect(count).toBe(2)
    })

    test('emits every valid sequence from the same node id', async () => {
        const port = randomPort()
        const receiver = createDiscovery('secret', { port, node_id: 'receiver' })
        await waitReady(receiver)

        const seqs: number[] = []
        receiver.subscribe(event => seqs.push(event.seq))

        await sendRaw(createRawPacket('secret', message({ node_id: 'sender', seq: 2 })), port)
        await sendRaw(createRawPacket('secret', message({ node_id: 'sender', seq: 1 })), port)
        await sendRaw(createRawPacket('secret', message({ node_id: 'sender', seq: 3 })), port)
        await sleep(250)

        expect(seqs).toEqual([2, 1, 3])
    })

    test('rejects expired packets', async () => {
        const port = randomPort()
        const receiver = createDiscovery('secret', { port, node_id: 'receiver' })
        await waitReady(receiver)

        let received = false
        receiver.subscribe(() => { received = true })

        await sendRaw(createRawPacket('secret', message({ node_id: 'sender', seq: 1 }), Date.now() - 31_000), port)
        await sleep(250)

        expect(received).toBe(false)
    })

    test('rejects legacy node-shaped UDP packets', async () => {
        const port = randomPort()
        const receiver = createDiscovery('secret', { port, node_id: 'receiver' })
        await waitReady(receiver)

        let received = false
        receiver.subscribe(() => { received = true })

        await sendRaw(createLegacyRawPacket('secret', {
            node_id: 'sender',
            namespace: 'test',
            version: 1,
            role: 'service',
        }), port)
        await sleep(250)

        expect(received).toBe(false)
    })

    test('relays an external packet even when the current shared key does not match', async () => {
        const port = randomPort()
        const relay = createDiscovery('project-a-key', { port, node_id: 'relay' })
        const receiver = createDiscovery('project-b-key', { port, node_id: 'receiver' })
        await Promise.all([waitReady(relay), waitReady(receiver)])
        const raw = createRawPacket('project-b-key', message({ node_id: 'sender', seq: 1 }))

        let relayConsumed = false
        relay.subscribe(() => { relayConsumed = true })

        const receivedP = nextMessage(receiver)
        await sendRaw(raw, port)

        const received = await receivedP
        expect(received.node_id).toBe('sender')
        expect(relayConsumed).toBe(false)
    })

    test('close is idempotent and stops future emissions', async () => {
        const port = randomPort()
        const receiver = createDiscovery('secret', { port, node_id: 'receiver' })
        await waitReady(receiver)
        const raw = createRawPacket('secret', message({ node_id: 'sender', seq: 1 }))

        let received = false
        receiver.subscribe(() => { received = true })

        receiver.close()
        receiver.close()
        await sendRaw(raw, port)
        await sleep(250)

        expect(received).toBe(false)
    })

    test('tracks lifecycle status', async () => {
        const port = randomPort()
        const discovery = createDiscovery('secret', { port, node_id: 'receiver' })
        const statuses: string[] = []
        discovery.status$.subscribe(status => statuses.push(status))

        await waitReady(discovery)
        discovery.close()

        expect(statuses).toEqual(['not_ready', 'ready', 'closed'])
    })
})

function createDiscovery(
    key: string,
    options: Omit<UdpDiscoveryOptions, 'key' | 'namespace' | 'tags'> & Partial<Pick<UdpDiscoveryOptions, 'namespace' | 'tags'>>,
) {
    const discovery = new UdpDiscovery<Metadata>({
        namespace: options.namespace ?? 'test',
        tags: options.tags ?? ['livequery'],
        key,
        ...options,
    })
    discoveries.push(discovery)
    return discovery
}

function nextMessage(discovery: UdpDiscovery<Metadata>) {
    return firstValueFrom(discovery.pipe(timeout({ first: 2_000 })))
}

function waitReady(discovery: UdpDiscovery<Metadata>) {
    return firstValueFrom(discovery.status$.pipe(
        filter(status => status === 'ready'),
        timeout({ first: 2_000 }),
    ))
}

function randomPort() {
    return 20_000 + Math.floor(Math.random() * 20_000)
}

function message(options: {
    node_id: string
    seq: number
    namespace?: string
    tags?: string[]
}): DiscoveryMessage<Metadata> {
    return {
        node_id: options.node_id,
        namespace: options.namespace ?? 'test',
        tags: options.tags ?? ['livequery', 'service'],
        version: String(options.seq),
        created_at: Date.now(),
        seq: options.seq,
        data: {
            role: options.node_id.includes('receiver') || options.node_id === 'relay' ? 'gateway' : 'service',
            name: 'posts',
        },
    }
}

function createRawPacket(key: string, body: DiscoveryMessage<Metadata>, timestamp = Date.now()) {
    const unsigned: Omit<UdpDiscoveryPacket<Metadata>, 'signature'> = {
        version: 1,
        sender_id: body.node_id,
        timestamp,
        message: body,
    }
    const signature = createHmac('sha256', key).update(pack(unsigned)).digest('hex')
    return pack({ ...unsigned, signature })
}

function createLegacyRawPacket(key: string, node: Record<string, unknown>, timestamp = Date.now()) {
    const unsigned = {
        version: 1,
        sender_id: node.node_id,
        timestamp,
        node,
    }
    const signature = createHmac('sha256', key).update(pack(unsigned)).digest('hex')
    return pack({ ...unsigned, signature })
}

function sendRaw(raw: Buffer, port: number, host = '127.0.0.1') {
    return new Promise<void>((resolve, reject) => {
        const socket = createSocket('udp4')
        socket.send(raw, 0, raw.length, port, host, e => {
            socket.close()
            e ? reject(e) : resolve()
        })
    })
}

function sleep(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms))
}

