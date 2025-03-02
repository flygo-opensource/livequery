import { createSocket } from "dgram"
import { Observable } from "rxjs"
import { API_GATEWAY_NAMESPACE, API_GATEWAY_UDP_ADDRESS, LIVEQUERY_API_GATEWAY_RAW_DEBUG } from "./const.js"
import { randomUUID } from "crypto"

export type UdpHello<T> = T & { id: string, host: string, namespace: string }

export class RxjsUdp<T> extends Observable<UdpHello<T>> {

    public readonly id = randomUUID()

    #udp = createSocket({
        type: 'udp4',
        reuseAddr: true
    })

    #whitelist_ips = [
        '255.255.255.255',
        ...API_GATEWAY_UDP_ADDRESS.split(',').map(a => {
            const s = a.trim().split('.')
            if (s.length == 4) return [a.trim()]
            if (s.length == 3) return new Array(255).fill(0).map((_, i) => [...s, i].join('.'))
            return []
        }).flat(2)
    ]

    constructor(port: number) {
        super(o => {


            this.#udp.on('message', async (raw, rinfo) => {
                try {
                    LIVEQUERY_API_GATEWAY_RAW_DEBUG && console.log({ rinfo, data: raw.toString('utf8') })
                    if (!this.#whitelist_ips.includes(rinfo.address)) return
                    const info = JSON.parse(raw.toString('utf-8')) as UdpHello<T>
                    if (info.namespace == API_GATEWAY_NAMESPACE && info.id != this.id) {
                        o.next({ ...info, host: rinfo.address })
                    }

                } catch (e) {
                }
            })

            this.#udp.bind({
                address: '0.0.0.0',
                port,
            }, () => this.#udp.setBroadcast(true))
        })
    }

    async broadcast({ payload, port, host }: { port: number, payload: T, host?: string }) {
        const hosts = host ? [host] : this.#whitelist_ips
        const data = JSON.stringify({
            namespace: API_GATEWAY_NAMESPACE,
            id: this.id,
            ...payload,
        })
        LIVEQUERY_API_GATEWAY_RAW_DEBUG && console.log({ broadcast: hosts, port, data })
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