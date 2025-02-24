import { createSocket } from "dgram"
import { Observable } from "rxjs"
import { networkInterfaces } from 'os'
import { API_GATEWAY_NAMESPACE, API_GATEWAY_UDP_ADDRESS, API_GATEWAY_UDP_PORT } from "./const.js"
import { ServiceApiMetadata } from "./ApiGateway.js"
import { randomUUID } from "crypto"


export class RxjsUdp extends Observable<ServiceApiMetadata & { host: string }> {

    private static  isGateway = false 

    public readonly id = randomUUID()

    #udp = createSocket({
        type: 'udp4',
        reuseAddr: true
    })

    #broadcast_ips = ['localhost']

    constructor(

    ) {
        super(o => {
            this.#udp.bind({
                address: '0.0.0.0',
                port: API_GATEWAY_UDP_PORT,
            }, () => this.#udp.setBroadcast(true))

            this.#udp.on('message', async (raw, rinfo) => {
                try {
                    const info = JSON.parse(raw.toString('utf-8')) as ServiceApiMetadata
                    if (info.namespace == API_GATEWAY_NAMESPACE && info.id != this.id) {
                        o.next({ ...info, host: rinfo.address })
                    }

                } catch (e) {
                }
            })

            const network_address = (
                Object.entries(networkInterfaces())
                    .filter(([i]) => !i.startsWith('lo'))
                    .map(e => e[1])
                    .flat(2)
                    .filter(d => d.family == 'IPv4')
                    .map(d => d.address.split('.').slice(0, 3).join('.') + '.255')
            )
            const env_address = API_GATEWAY_UDP_ADDRESS.split(',').map(a => a.trim()).filter(a => !!a)

            for (const address of [...network_address, ...env_address]) {
                const splited = address.split('.')
                splited.length == 4 && this.#broadcast_ips.push(address)
                splited.length == 3 && new Array(256).fill(0).map((_, i) => this.#broadcast_ips.push(`${address}.${i}`))
            }
        })
    }

    async broadcast(metadata: ServiceApiMetadata, ip?: string) { 
        for (const host of [
            ...this.#broadcast_ips,
            ... ip ? [ip]:[]
        ]) {
            await this.#udp.send(
                JSON.stringify({ ...metadata, id: this.id }),
                API_GATEWAY_UDP_PORT,
                host
            )
        }
    }
 

    forService(){

    }
}