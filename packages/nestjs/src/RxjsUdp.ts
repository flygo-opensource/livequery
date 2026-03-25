import { createSocket } from "dgram";
import { networkInterfaces } from "os";
import { API_GATEWAY_WHITELIST_ADDRESS, API_GATEWAY_MULTICAST_PORT, API_GATEWAY_MULTICAST_ADDRESS } from "./const.js";
import { BehaviorSubject, debounceTime, from, map, ReplaySubject } from "rxjs";
import { firstValueFrom, fromEvent } from "rxjs";
import { switchMap, mergeMap, filter } from "rxjs/operators";
import { unpack, pack } from 'msgpackr'

export type NodeMetadata<T = {}> = T & {
    host: string
    node_id: string
    namespace: string
}

export type MdnsMessage<T extends NodeMetadata> = {
    hi: boolean
    node: T
    sender_id: string
    forwarder_id?: string
    receiver_id?: string
}


export class RxjsUdp  {

    #udp4 = createSocket({
        type: 'udp4',
        reuseAddr: true
    })

    #localAddress = new Set(
        Object.values(networkInterfaces()).flat(2).map(e => e?.address).filter(Boolean)
    )
    #broadcastAddress = new Set([
        API_GATEWAY_MULTICAST_ADDRESS,
        ...(API_GATEWAY_WHITELIST_ADDRESS || '').split(',').map(e => {
            const ppps = e.trim().split('.')
            if (ppps.length == 4) return e.trim()
            if (ppps.length == 3) return new Array(256).fill(0).map((h, index) => {
                return `${e.trim()}.${index}`
            })
            return []
        }).flat(2)
    ])

    constructor() {
        this.#udp4.on('listening', () => {
            this.#udp4.setMulticastInterface("127.0.0.1");
            this.#udp4.addMembership(API_GATEWAY_MULTICAST_ADDRESS, "127.0.0.1");
        })
        this.#udp4.on('error', (e) => {
            throw e
        })
        this.#udp4.bind(API_GATEWAY_MULTICAST_PORT, '0.0.0.0')
    }

    async broadcast<T extends NodeMetadata>(data: MdnsMessage<T>, ips: string[] = [...this.#broadcastAddress]) {
        const msg = pack(data)
        for (const ip of ips) {
            this.#udp4.send(msg, 0, msg.length, API_GATEWAY_MULTICAST_PORT, ip, e => {
                e && console.error('UDP Broadcast error', e)
            })
        }
    }


    link<T extends NodeMetadata>(metadata$: BehaviorSubject<T> | ReplaySubject<T>) {
        return from(firstValueFrom(metadata$)).pipe(
            debounceTime(1000),
            mergeMap(async metadata => {
                this.broadcast({
                    node: metadata,
                    hi: true,
                    sender_id: metadata.node_id
                })
                return metadata
            }),
            switchMap(metadata => fromEvent(this.#udp4, 'message').pipe(
                map(([raw, r]) => ({ raw, r, metadata }))
            )),
            mergeMap(async ({ raw, r, metadata }) => {

                try {
                    const msg = unpack(raw) as MdnsMessage<T>
                    if (msg.node.node_id == metadata.node_id) return
                    if (msg.sender_id == metadata.node_id) return
                    if (msg.forwarder_id == metadata.node_id) return
                    if (msg.node.namespace != metadata.namespace) return



                    // Forward message in case from remote
                    const node = { ...msg.node, host: msg.node.host || r.address }
                    const is_remote = !this.#localAddress.has(r.address);
                    is_remote && !msg.forwarder_id && await this.broadcast({
                        ...msg,
                        node,
                        forwarder_id: metadata.node_id
                    }, [API_GATEWAY_MULTICAST_ADDRESS]);

                    // Ignore if message has receiver and it's not me
                    if (msg.receiver_id && msg.receiver_id != metadata.node_id) return;

                    // Say hi back if first time seen 
                    if (msg.hi) {
                        const node = await firstValueFrom(metadata$)
                        await this.broadcast({
                            node,
                            hi: false,
                            sender_id: node.node_id,
                            receiver_id: msg.sender_id
                        }, [is_remote ? r.address : API_GATEWAY_MULTICAST_ADDRESS]);
                    }
                    // Emit node
                    return node

                } catch (e) { }
            }),
            filter(Boolean)
        )
    }

}
