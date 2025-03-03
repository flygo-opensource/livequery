import { createSocket, RemoteInfo } from "dgram"
import { EMPTY, filter, finalize, firstValueFrom, fromEvent, map, merge, mergeMap, Observable, of, retry, tap, timer } from "rxjs"
import { API_GATEWAY_NAMESPACE, API_GATEWAY_UDP_ADDRESS, LIVEQUERY_API_GATEWAY_RAW_DEBUG, UDP_MULTICAST_ADDRESS, UDP_LOCAL_PORT, UDP_PUBLIC_PORT } from "./const.js"
import { randomUUID } from "crypto"
import { networkInterfaces } from "os"

export type UdpHello<T = {}> = T & {
    sender_id: string,
    relay_id: string
    host: string,
    namespace: string
}

LIVEQUERY_API_GATEWAY_RAW_DEBUG && console.log({ LIVEQUERY_API_GATEWAY_RAW_DEBUG: 'ON' })

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

            LIVEQUERY_API_GATEWAY_RAW_DEBUG && console.log({ 'IAM': RxjsUdp.id })

            this.#udp.local.bind(UDP_LOCAL_PORT, '0.0.0.0', () => {
                this.#udp.local.addMembership(UDP_MULTICAST_ADDRESS);
            });

            this.#udp.public.bind(UDP_PUBLIC_PORT, '0.0.0.0');


            const subscription = merge(
                fromEvent(this.#udp.public, 'message').pipe(
                    map(([raw, rinfo]: [Buffer, RemoteInfo]) => {
                        if (!this.#whitelist_ips.includes(rinfo.address)) return
                        const msg = JSON.parse(raw.toString('utf-8')) as UdpHello<T>
                        msg.relay_id = RxjsUdp.id
                        msg.host = rinfo.address;
                        return { msg, public: true }
                    })
                ),
                fromEvent(this.#udp.local, 'message').pipe(
                    map(([raw, rinfo]: [Buffer, RemoteInfo]) => {
                        if (!this.#local_addresses.includes(rinfo.address)) return
                        const msg: UdpHello<T> = JSON.parse(raw.toString('utf-8'))
                        if (msg.relay_id == RxjsUdp.id) return
                        return { msg, public: false }
                    })
                )
            ).pipe(
                filter(Boolean),
                filter(({ msg }) => msg.namespace == API_GATEWAY_NAMESPACE),
                tap(msg => LIVEQUERY_API_GATEWAY_RAW_DEBUG && console.log(msg)),
                tap(({ msg }) => msg.sender_id != RxjsUdp.id && o.next(msg)),
                filter(from => from.public),
                mergeMap(({ msg }) => {
                    const buffer = Buffer.from(JSON.stringify(msg))
                    return of(0).pipe(
                        mergeMap(() => new Promise<void>((s, r) => {
                            this.#udp.public.send(buffer, UDP_LOCAL_PORT, UDP_MULTICAST_ADDRESS, (e, b) => {
                                e ? r(e) : s()
                            })
                        })),
                        retry({
                            delay: (e, n) => {
                                // e && console.error(e)
                                return n < 10 ? timer(n * 100) : EMPTY
                            }
                        })
                    )
                })
            ).subscribe()

            return () => subscription.unsubscribe()
        });
    }

    async broadcast({ payload, host }: { payload: T, host?: string }) {
        const hosts = host ? [host] : this.#whitelist_ips
        const data = JSON.stringify({
            namespace: API_GATEWAY_NAMESPACE,
            relay_id: '',
            host: '',
            sender_id: RxjsUdp.id,
            ...payload,
        } as UdpHello<T>)
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