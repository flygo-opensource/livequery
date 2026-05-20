import { afterEach, describe, expect, test } from 'bun:test'
import { createHmac } from 'crypto'
import { createSocket } from 'dgram'
import { pack } from 'msgpackr'
import { filter, firstValueFrom, timeout } from 'rxjs'
import { UdpDiscovery, type UdpDiscoveryNode, type UdpDiscoveryOptions, type UdpDiscoveryPacket } from '../src/UdpDiscovery.js'

type TestNode = UdpDiscoveryNode & {
    role: 'gateway' | 'service'
}

const discoveries: UdpDiscovery<TestNode>[] = []

afterEach(() => {
    for (const discovery of discoveries.splice(0)) {
        discovery.close()
    }
})

describe('UdpDiscovery', () => {
    test('emits another node with the same shared key and namespace', async () => {
        const { port, localRelayPort } = portPair()
        const receiver = createDiscovery('secret', { port })
        await waitReady(receiver)
        const raw = createRawPacket('secret', {
            node_id: 'sender',
            namespace: 'app',
            version: 1,
            role: 'service',
        })

        const nodeP = nextNode(receiver)
        await sendRaw(raw, localRelayPort)

        const node = await nodeP
        expect(node.node_id).toBe('sender')
        expect(node.namespace).toBe('app')
    })

    test('does not emit a node signed with a different shared key', async () => {
        const { port } = portPair()
        const receiver = createDiscovery('secret-a', { port })
        const sender = createDiscovery('secret-b', { port })
        await Promise.all([waitReady(receiver), waitReady(sender)])

        let received = false
        receiver.subscribe(() => { received = true })

        await sender.broadcast(testNode('sender', 'app'), '127.0.0.1')
        await sleep(250)

        expect(received).toBe(false)
    })

    test('emits nodes from any namespace and leaves namespace filtering to consumers', async () => {
        const { port } = portPair()
        const receiver = createDiscovery('secret', { port })
        const sender = createDiscovery('secret', { port })
        await Promise.all([waitReady(receiver), waitReady(sender)])

        const nodeP = nextNode(receiver)

        await sender.broadcast(testNode('sender', 'app-b'), '127.0.0.1')

        const node = await nodeP
        expect(node.namespace).toBe('app-b')
    })

    test('broadcast sends a signed packet to an explicit IP', async () => {
        const { port } = portPair()
        const receiver = createDiscovery('secret', { port })
        const sender = createDiscovery('secret', { port })
        await Promise.all([waitReady(receiver), waitReady(sender)])

        const nodeP = nextNode(receiver)
        await sender.broadcast(testNode('sender', 'app'), '127.0.0.1')

        const node = await nodeP
        expect(node.node_id).toBe('sender')
    })

    test('emits duplicate packets and leaves dedupe to consumers', async () => {
        const { port, localRelayPort } = portPair()
        const receiver = createDiscovery('secret', { port })
        await waitReady(receiver)
        const raw = createRawPacket('secret', {
            node_id: 'sender',
            namespace: 'app',
            version: 1,
            role: 'service',
        })

        let count = 0
        receiver.subscribe(() => { count++ })

        await sendRaw(raw, localRelayPort)
        await sendRaw(raw, localRelayPort)
        await sleep(250)

        expect(count).toBe(2)
    })

    test('emits every valid metadata version from the same node id', async () => {
        const { port, localRelayPort } = portPair()
        const receiver = createDiscovery('secret', { port })
        await waitReady(receiver)

        const versions: number[] = []
        receiver.subscribe(node => versions.push(node.version))

        await sendRaw(createRawPacket('secret', {
            node_id: 'sender',
            namespace: 'app',
            role: 'service',
            version: 2,
        }), localRelayPort)
        await sendRaw(createRawPacket('secret', {
            node_id: 'sender',
            namespace: 'app',
            role: 'service',
            version: 1,
        }), localRelayPort)
        await sendRaw(createRawPacket('secret', {
            node_id: 'sender',
            namespace: 'app',
            role: 'service',
            version: 3,
        }), localRelayPort)
        await sleep(250)

        expect(versions).toEqual([2, 1, 3])
    })

    test('broadcast requires node every time', async () => {
        const { port } = portPair()
        const receiver = createDiscovery('secret', { port })
        const sender = createDiscovery('secret', { port })
        await Promise.all([waitReady(receiver), waitReady(sender)])

        const versions: number[] = []
        receiver.subscribe(node => versions.push(node.version))

        await sender.broadcast({
            node_id: 'sender',
            namespace: 'app',
            role: 'service',
            version: 1,
        }, '127.0.0.1')
        await sender.broadcast({
            node_id: 'sender',
            namespace: 'app',
            role: 'service',
            version: 2,
        }, '127.0.0.1')
        await sleep(250)

        expect(versions).toEqual([1, 2])
    })

    test('rejects expired packets', async () => {
        const { port, localRelayPort } = portPair()
        const receiver = createDiscovery('secret', { port })
        await waitReady(receiver)
        const raw = createRawPacket('secret', {
            node_id: 'sender',
            namespace: 'app',
            version: 1,
            role: 'service',
        }, Date.now() - 31_000)

        let received = false
        receiver.subscribe(() => { received = true })

        await sendRaw(raw, localRelayPort)
        await sleep(250)

        expect(received).toBe(false)
    })

    test('relays an external packet even when the current shared key does not match', async () => {
        const { port } = portPair()
        const relay = createDiscovery('project-a-key', { port })
        const receiver = createDiscovery('project-b-key', { port })
        await Promise.all([waitReady(relay), waitReady(receiver)])
        const raw = createRawPacket('project-b-key', {
            node_id: 'sender',
            namespace: 'app',
            version: 1,
            role: 'service',
        })

        let relayConsumed = false
        relay.subscribe(() => { relayConsumed = true })

        const nodeP = nextNode(receiver)
        await sendRaw(raw, port)

        const node = await nodeP
        expect(node.node_id).toBe('sender')
        expect(relayConsumed).toBe(false)
    })

    test('close is idempotent and stops future emissions', async () => {
        const { port, localRelayPort } = portPair()
        const receiver = createDiscovery('secret', { port })
        await waitReady(receiver)
        const raw = createRawPacket('secret', {
            node_id: 'sender',
            namespace: 'app',
            version: 1,
            role: 'service',
        })

        let received = false
        receiver.subscribe(() => { received = true })

        receiver.close()
        receiver.close()
        await sendRaw(raw, localRelayPort)
        await sleep(250)

        expect(received).toBe(false)
    })

    test('tracks lifecycle status', async () => {
        const { port } = portPair()
        const discovery = createDiscovery('secret', { port })
        const statuses: string[] = []
        discovery.status$.subscribe(status => statuses.push(status))

        await waitReady(discovery)
        discovery.close()

        expect(statuses).toEqual(['not_ready', 'ready', 'closed'])
    })
})

function createDiscovery(
    key: string,
    options: Omit<UdpDiscoveryOptions, 'key'>,
) {
    const discovery = new UdpDiscovery<TestNode>({
        key,
        ...options,
    })
    discoveries.push(discovery)
    return discovery
}

function testNode(node_id: string, namespace: string): TestNode {
    return {
        node_id,
        namespace,
        version: 1,
        role: node_id.includes('receiver') || node_id === 'relay' ? 'gateway' : 'service',
    }
}

function nextNode(discovery: UdpDiscovery<TestNode>) {
    return firstValueFrom(discovery.pipe(timeout({ first: 2_000 })))
}

function waitReady(discovery: UdpDiscovery<TestNode>) {
    return firstValueFrom(discovery.status$.pipe(
        filter(status => status === 'ready'),
        timeout({ first: 2_000 }),
    ))
}

function portPair() {
    const base = 20_000 + Math.floor(Math.random() * 20_000)
    return {
        port: base,
        localRelayPort: base,
    }
}

function createRawPacket(key: string, node: TestNode, timestamp = Date.now()) {
    const unsigned: Omit<UdpDiscoveryPacket<TestNode>, 'signature'> = {
        version: 1,
        sender_id: node.node_id,
        timestamp,
        node,
    }
    const signature = createHmac('sha256', key).update(pack(unsigned)).digest('hex')
    return pack({ ...unsigned, signature })
}

function sendRaw(raw: Buffer, port: number, host = '127.0.0.1', bindAddress?: string) {
    return new Promise<void>((resolve, reject) => {
        const socket = createSocket('udp4')
        const send = () => socket.send(raw, 0, raw.length, port, host, e => {
            socket.close()
            e ? reject(e) : resolve()
        })
        if (bindAddress) socket.bind(0, bindAddress, send)
        else send()
    })
}

function sleep(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms))
}
