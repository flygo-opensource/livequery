import { createHmac } from 'crypto'
import { createSocket, type RemoteInfo, type Socket } from 'dgram'
import { networkInterfaces } from 'os'
import { BehaviorSubject, Observable, Subject, Subscriber, Subscription } from 'rxjs'
import { pack, unpack } from 'msgpackr'
import {
    API_GATEWAY_MULTICAST_ADDRESS,
    API_GATEWAY_MULTICAST_PORT,
    API_GATEWAY_WHITELIST_ADDRESS,
} from './const.js'

export type UdpDiscoveryNode = {
    node_id: string
    namespace: string
    version: number
    host?: string
}

export type UdpDiscoveryOptions = {
    key: string
    port?: number
}

export type UdpDiscoveryPacket<T extends UdpDiscoveryNode> = {
    version: 1
    sender_id: string
    timestamp: number
    node: T
    signature: string
}

type UnsignedPacket<T extends UdpDiscoveryNode> = Omit<UdpDiscoveryPacket<T>, 'signature'>

type DecodedPacket<T extends UdpDiscoveryNode> = {
    packet: UdpDiscoveryPacket<T>
    unsigned: UnsignedPacket<T>
}

type UdpDiscoveryConfig = {
    key: string
    port: number
    peers: string[]
}

export type UdpDiscoveryStatus = 'not_ready' | 'ready' | 'closed'

const BIND_ADDRESS = '0.0.0.0'
const DEFAULT_PACKET_TTL_MS = 30_000

export class UdpDiscovery<T extends UdpDiscoveryNode> extends Observable<T> {
    readonly #nodes = new Subject<T>()
    readonly #status$ = new BehaviorSubject<UdpDiscoveryStatus>('not_ready')
    readonly #externalSocket = createSocket({ type: 'udp4', reuseAddr: true, reusePort: true } as any)
    readonly #localSocket = createSocket({ type: 'udp4', reuseAddr: true, reusePort: true } as any)
    readonly #localAddresses = this.#readLocalAddresses()

    readonly status$: Observable<UdpDiscoveryStatus> = this.#status$.asObservable()

    readonly #config: UdpDiscoveryConfig

    constructor(options: UdpDiscoveryOptions) {
        super((subscriber: Subscriber<T>) => this.#nodes.subscribe(subscriber))
        const port = options.port ?? API_GATEWAY_MULTICAST_PORT
        this.#config = {
            key: options.key,
            port,
            peers: [
                API_GATEWAY_MULTICAST_ADDRESS,
                ...this.#expandPeers(this.#envPeers()),
            ],
        }

        this.#bindSockets()
    }

    async broadcast(node: T, targetIp?: string | string[]): Promise<void> {
        await this.#waitReady()
        if (this.#isClosed()) return

        const ips = targetIp ? [targetIp].flat(2) : this.#config.peers
        const packet = this.#createPacket(node)
        const raw = pack(packet)
        await Promise.all(ips.map(ip => this.#send(this.#externalSocket, raw, this.#config.port, ip)))
        if (!targetIp) await this.#sendLocal(packet)
    }

    close(): void {
        if (this.#isClosed()) return
        this.#status$.next('closed')
        this.#nodes.complete()
        this.#status$.complete()
        this.#externalSocket.close()
        this.#localSocket.close()
    }

    #bindSockets(): void {
        this.#externalSocket.on('message', (raw, rinfo) => this.#onExternalMessage(raw, rinfo))
        this.#externalSocket.on('error', e => this.#onError(e))
        const externalReady = new Promise<void>(resolve => this.#externalSocket.once('listening', () => {
            this.#configureMulticast(this.#externalSocket)
            for (const address of this.#localAddresses) {
                try {
                    this.#externalSocket.addMembership(API_GATEWAY_MULTICAST_ADDRESS, address)
                } catch { }
            }
            resolve()
        }))
        this.#externalSocket.bind(this.#config.port, BIND_ADDRESS)

        this.#localSocket.on('message', (raw, rinfo) => this.#onLocalMessage(raw, rinfo))
        this.#localSocket.on('error', e => this.#onError(e))
        const localReady = new Promise<void>(resolve => this.#localSocket.once('listening', () => {
            this.#configureMulticast(this.#localSocket)
            for (const address of this.#localAddresses) {
                try {
                    this.#localSocket.addMembership(API_GATEWAY_MULTICAST_ADDRESS, address)
                } catch { }
            }
            resolve()
        }))
        this.#localSocket.bind(this.#config.port, BIND_ADDRESS)

        Promise.all([externalReady, localReady]).then(() => {
            if (!this.#isClosed()) this.#status$.next('ready')
        })
    }

    async #onExternalMessage(raw: Buffer, rinfo: RemoteInfo): Promise<void> {
        if (this.#isClosed()) return
        const decoded = this.#decode(raw)
        if (!decoded) return

        const signatureMatches = decoded.packet.signature === this.#sign(decoded.unsigned)
        const shouldRelay = !this.#isLocalAddress(rinfo.address)
            || (rinfo.port !== this.#config.port && !signatureMatches)

        if (shouldRelay) {
            await this.#relayLocal(raw)
        }

        this.#consume(decoded, rinfo.address)
    }

    #onLocalMessage(raw: Buffer, rinfo: RemoteInfo): void {
        if (this.#isClosed()) return
        const decoded = this.#decode(raw)
        if (!decoded) return
        this.#consume(decoded, rinfo.address)
    }

    #consume({ packet, unsigned }: DecodedPacket<T>, host: string): void {
        if (Math.abs(Date.now() - packet.timestamp) > DEFAULT_PACKET_TTL_MS) return
        if (packet.signature !== this.#sign(unsigned)) return

        this.#nodes.next({
            ...packet.node,
            host: packet.node.host || host,
        })
    }

    #decode(raw: Buffer): DecodedPacket<T> | undefined {
        try {
            const packet = unpack(raw) as UdpDiscoveryPacket<T>
            if (packet.version !== 1) return
            if (!packet.sender_id || !packet.timestamp || !packet.node || !packet.signature) return
            if (!packet.node.node_id || typeof packet.node.version !== 'number') return
            const { signature: _signature, ...unsigned } = packet
            return { packet, unsigned }
        } catch {
            return
        }
    }

    #createPacket(node: T): UdpDiscoveryPacket<T> {
        const unsigned: UnsignedPacket<T> = {
            version: 1,
            sender_id: node.node_id,
            timestamp: Date.now(),
            node,
        }
        return {
            ...unsigned,
            signature: this.#sign(unsigned),
        }
    }

    #sign(packet: UnsignedPacket<T>): string {
        return createHmac('sha256', this.#config.key).update(pack(packet)).digest('hex')
    }

    async #relayLocal(raw: Buffer): Promise<void> {
        await Promise.all([
            this.#sendLocalMulticast(raw),
            this.#send(this.#localSocket, raw, this.#config.port, '127.0.0.1'),
        ])
    }

    async #sendLocal(packet: UdpDiscoveryPacket<T>): Promise<void> {
        await this.#sendLocalMulticast(pack(packet))
    }

    async #sendLocalMulticast(raw: Buffer): Promise<void> {
        const addresses = [...this.#localAddresses].filter(address => address.includes('.') && address !== '0.0.0.0')
        for (const address of addresses) {
            try { this.#localSocket.setMulticastInterface(address) } catch { }
            await this.#send(this.#localSocket, raw, this.#config.port, API_GATEWAY_MULTICAST_ADDRESS)
        }
    }

    #isLocalAddress(address: string): boolean {
        return this.#localAddresses.has(address)
    }

    #send(socket: Socket, raw: Buffer, port: number, host: string): Promise<void> {
        return new Promise(resolve => {
            if (this.#isClosed()) {
                resolve()
                return
            }
            socket.send(raw, 0, raw.length, port, host, e => {
                if (e) this.#onError(e)
                resolve()
            })
        })
    }

    #configureMulticast(socket: Socket): void {
        try { socket.setMulticastTTL(1) } catch { }
        try { socket.setMulticastLoopback(true) } catch { }
    }

    #readLocalAddresses(): Set<string> {
        const addresses = Object.values(networkInterfaces())
            .flatMap(items => items ?? [])
            .map(item => item.address)
            .filter(Boolean)
        return new Set(['127.0.0.1', '0.0.0.0', ...addresses])
    }

    #envPeers(): string[] {
        return API_GATEWAY_WHITELIST_ADDRESS
            .split(',')
            .map(ip => ip.trim())
            .filter(Boolean)
    }

    #expandPeers(peers: string[]): string[] {
        return peers.flatMap(peer => {
            const parts = peer.trim().split('.')
            if (parts.length === 4) return [peer.trim()]
            if (parts.length === 3) {
                return Array.from({ length: 256 }, (_, index) => `${peer.trim()}.${index}`)
            }
            return []
        })
    }

    #waitReady(): Promise<void> {
        const status = this.#status$.getValue()
        if (status === 'ready' || status === 'closed') return Promise.resolve()

        return new Promise(resolve => {
            let subscription: Subscription | undefined
            subscription = this.#status$.subscribe(next => {
                if (next !== 'ready' && next !== 'closed') return
                subscription?.unsubscribe()
                resolve()
            })
        })
    }

    #onError(error: unknown): void {
        if (this.#isClosed()) return
        if (process.env.LIVEQUERY_UDP_DEBUG) console.error(error)
    }

    #isClosed(): boolean {
        return this.#status$.getValue() === 'closed'
    }
}
