import { createSocket } from "dgram"
import { Observable } from "rxjs"
import { API_GATEWAY_NAMESPACE, API_GATEWAY_UDP_ADDRESS, LIVEQUERY_API_GATEWAY_RAW_DEBUG, UDP_PRIVATE_PORT, UDP_PUBLIC_PORT } from "./const.js"
import { randomUUID } from "crypto"
import { networkInterfaces } from "os"

export type UdpHello<T> = T & { id: string, host: string, namespace: string }

LIVEQUERY_API_GATEWAY_RAW_DEBUG && console.log({LIVEQUERY_API_GATEWAY_RAW_DEBUG: 'ON'})

export class RxjsUdp<T> extends Observable<UdpHello<T>> {

    public static readonly id = randomUUID()


    #udp = {
        public: createSocket({
            type: 'udp4',
            reuseAddr: true
        }),
        local: createSocket({
            type: 'udp4',
            reuseAddr: true
        })
    }

    #local_addresses = Object.values(networkInterfaces()).map(a => a.map(q => q.address)).flat(2)

    #whitelist_ips = [
        '127.0.0.1',
        ...API_GATEWAY_UDP_ADDRESS.split(',').map(a => {
            const s = a.trim().split('.')
            if (s.length == 4) return [a.trim()]
            if (s.length == 3) return new Array(255).fill(0).map((_, i) => [...s, i].join('.'))
            return []
        }).flat(2)
    ]

    constructor() {
        super(o => {



            this.#udp.public.on('message', (raw, rinfo) => {
                if (!this.#whitelist_ips.includes(rinfo.address)) return
                const info = JSON.parse(raw.toString('utf-8')) as UdpHello<T>
                info.host = rinfo.address
                this.#udp.public.send(Buffer.from(JSON.stringify(info)), UDP_PRIVATE_PORT, '255.255.255.255')
            })

            this.#udp.local.on('message', (raw, rinfo) => {
                if (!this.#local_addresses.includes(rinfo.address)) return
                const info = JSON.parse(raw.toString('utf-8')) as UdpHello<T>
                LIVEQUERY_API_GATEWAY_RAW_DEBUG && console.log({ receive: info })
                if (info.namespace == API_GATEWAY_NAMESPACE && info.id != RxjsUdp.id) {
                    o.next(info)
                }
            })

            this.#udp.public.bind(UDP_PUBLIC_PORT, '0.0.0.0', () => this.#udp.public.setBroadcast(true))
            this.#udp.local.bind(UDP_PRIVATE_PORT, '0.0.0.0', () => this.#udp.local.setBroadcast(true))
        })
    }

    async broadcast({ payload, host }: { payload: T, host?: string }) {
        const hosts = host ? [host] : this.#whitelist_ips
        const data = JSON.stringify({
            namespace: API_GATEWAY_NAMESPACE,
            id: RxjsUdp.id,
            ...payload,
        })
        LIVEQUERY_API_GATEWAY_RAW_DEBUG && console.log({ broadcast: hosts, data, port: UDP_PUBLIC_PORT })
        for (const host of hosts) {
            await new Promise(s => {
                this.#udp.public.send(
                    data,
                    UDP_PUBLIC_PORT,
                    host,
                    s
                )
            })
        }
    }
}