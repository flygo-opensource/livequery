import { createSocket } from "dgram"
import { Observable } from "rxjs"
import { API_GATEWAY_NAMESPACE, API_GATEWAY_UDP_ADDRESS, API_GATEWAY_UDP_PORT } from "./const.js"
import { randomUUID } from "crypto"

export type UdpHello<T> = T & { id: string, host: string, namespace: string }

export class RxjsUdp<T> extends Observable<UdpHello<T>> {

    public readonly id = randomUUID()

    #udp = createSocket({
        type: 'udp6',
        reuseAddr: true
    })

    #whitelist_ips = [
        '127.0.0.1',
        ...API_GATEWAY_UDP_ADDRESS.split(',').map(a => {
            const s = a.trim().split('.')
            if (s.length == 4) return [a.trim()]
            if (s.length == 3) return new Array(255).fill(0).map((_, i) => [...s, i].join('.'))
            return []
        }).flat(2)
    ]

    constructor(
        private port: number
    ) {
        super(o => {


            this.#udp.bind({
                address: '0.0.0.0',
                port,
            }, () => this.#udp.setBroadcast(true))

            this.#udp.on('message', async (raw, rinfo) => {
                try {
                    if (!this.#whitelist_ips.includes(rinfo.address)) return
                    const info = JSON.parse(raw.toString('utf-8')) as UdpHello<T>
                    if (info.namespace == API_GATEWAY_NAMESPACE && info.id != this.id) {
                        o.next({ ...info, host: rinfo.address })
                    }

                } catch (e) {
                }
            })
        })
    }

    async broadcast({ payload, port, host }: { port: number, payload: T, host?: string }) {
        const hosts = host ? [host] : this.#whitelist_ips
        const data = JSON.stringify({
            namespace: API_GATEWAY_NAMESPACE,
            id: this.id,
            ...payload,
        })
        for (const host of hosts) {
            await new Promise(s => {
                this.#udp.send(
                    data,
                    port,
                    host,
                    s
                )
            })
        }
    }
}