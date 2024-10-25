import { Controller, Delete, Get, Optional, Patch, Post, Put, Request, Res, } from '@nestjs/common'
import * as http from 'http';
import { Response } from 'express';
import { IncomingMessage } from 'http';
import { LivequeryWebsocketSync } from './LivequeryWebsocketSync.js';
import { firstValueFrom, timer } from 'rxjs'
import { API_GATEWAY_NAMESPACE } from './const.js';
import { RxjsUdp } from './RxjsUdp.js';
import { mergeMap } from 'rxjs/operators'


export type Routing = {
    [ref: string]: {
        dpaths: string[]
        children?: Routing
        methods?: {
            [METHOD: string]: {
                hosts: string[]
                last_requested_index: number
            }
        }
    }
}



export type ServiceApiMetadata = {
    id: string,
    namespace: string
    role: 'service' | 'gateway',
    host: string,
    name: string
    port: number
    paths: Array<{
        method: string,
        path: string
    }>
    websocket?: string
    sig: string
}
export type ServiceApiStatus = {
    id: string
    online: boolean
    metadata?: ServiceApiMetadata
} | { id: string, online: false }


export type ApiGatewayClientOptions = {
    id: string
    name: string,
    controllers: any[],
    port: number
}

@Controller(`*`)
export class ApiGateway {

    #services = new Map<string, ServiceApiMetadata>
    #routing: Routing = {}
    #udp = new RxjsUdp()

    constructor(
        @Optional() private LivequeryWebsocketSync: LivequeryWebsocketSync
    ) {
        this.#udp.pipe(
            mergeMap(async ({ host, port }) => {
                const r: { data: ServiceApiMetadata } = await fetch(`http://${host}:${port}/api-gateway/metadata`).then(r => r.json())
                r.data && r.data.namespace == API_GATEWAY_NAMESPACE && this.#join(r.data)
            })
        )
        this.#udp.broadcast({
            namespace: API_GATEWAY_NAMESPACE,
            host: '',
            id: '',
            name: '',
            paths: [],
            port: 0,
            role: 'gateway',
            sig: ''
        })

    }



    async  #disconnect(id: string) {
        const service = this.#services.get(id)
        if (!service) return
        process.env.LIVEQUERY_API_GATEWAY_DEBUG && console.log(`Service API OFFLINE: ${service.name} at ${service.host}:${service.port}`)
        process.env.LIVEQUERY_API_GATEWAY_DEBUG && console.log(`Websocket API OFFLINE: ${service.name} at ${service.host}:${service.port}${service.websocket}`)
        this.#services.delete(id)
        const hostname = `${service.host}:${service.port}`
        for (
            let routes = [this.#routing];
            routes.length > 0;
            routes = routes.map(c => [...Object.values(c)].map(c => c.children).filter(c => !!c)).flat(2)
        ) {
            for (const route of routes) {
                for (const { methods } of Object.values(route || {})) {
                    for (const list of Object.values(methods || {})) {
                        if (list?.hosts.includes(hostname)) {
                            list.hosts = list?.hosts.filter(h => h != hostname)
                        }
                    }
                }
            }
        }
    }

    // async  #find_api_host(hosts: string[], port: number, loop: number = 10) {
    //     for (let i = 1; i <= loop; i++) {
    //         for (const hostname of hosts) {
    //             const connected = await new Promise<boolean>(s => {
    //                 const request = http.request({
    //                     hostname,
    //                     port,
    //                     method: 'HEAD'
    //                 })
    //                 request.on('response', () => s(true))
    //                 request.on('error', () => s(false))
    //                 request.end()
    //             })
    //             if (connected) return hostname
    //             await firstValueFrom(timer(1000))
    //         }
    //     }
    // }

    async #join(metadata: ServiceApiMetadata) {
        if (this.#services.has(metadata.id)) return
        this.#services.set(metadata.id, metadata)
        const hostname = `${metadata.host}:${metadata.port}`
        process.env.LIVEQUERY_API_GATEWAY_DEBUG && console.log(`Service API online: ${metadata.name} at ${metadata.host}:${metadata.port}`)
        process.env.LIVEQUERY_API_GATEWAY_DEBUG && console.log(`Websocket API online: ${metadata.name} at ${metadata.host}:${metadata.port}${metadata.websocket}`)
        metadata.websocket && this.LivequeryWebsocketSync?.connect(`ws://${hostname}${metadata.websocket}`)
        for (const { method, path } of metadata.paths) {

            const refs = path.split('/').map(r => {
                if (r.includes(':')) {
                    return `${r.split(':')[0]}:`
                }
                return r
            })

            const merge = async (routes: Routing[string], refs: string[]) => {

                if (refs.length == 0) {
                    if (!routes.methods) {
                        routes.methods = {}
                    }
                    const methods = routes.methods
                    const METHOD = method.toUpperCase()

                    if (!methods[METHOD]) {
                        methods[METHOD] = {
                            hosts: [hostname],
                            last_requested_index: 0
                        }
                        return
                    }
                    methods[METHOD].hosts = [...new Set([...methods[METHOD].hosts, hostname])]
                    return
                }
                const ref = refs[0]
                if (!routes.children[ref]) {
                    routes.children[ref] = {
                        children: {},
                        dpaths: []
                    }
                }
                if (ref != ':' && ref.includes(':')) {
                    const dref = ref.split(':')[0]
                    routes.children[ref].dpaths = [...new Set([...routes.children[ref].dpaths, dref])]
                }

                refs.length >= 0 && await merge(routes.children[ref], refs.slice(1))
            }

            await merge({ dpaths: [], children: this.#routing }, refs)
        }
    }

    #match(routing: Routing[string], ref: string) {
        const xm = routing.children[ref]
        if (xm) return xm
        if (routing.dpaths) {
            const matched = routing.dpaths.find(c => ref.startsWith(c))
            if (matched) return routing.children[matched]
        }
        return routing.children[':']
    }

    #resolve(path: string, method: string) {

        const refs = path.split('?')[0].split('/').slice(1)
        for (
            let cur = refs.shift(), routes = this.#match({ dpaths: [], children: this.#routing }, cur);
            cur != undefined && routes;
            cur = refs.shift(), routes = this.#match(routes, cur)
        ) {
            if (refs.length == 0) {
                const metadata = routes.methods?.[method]
                if (metadata) {
                    if (metadata.hosts.length == 0) return null
                    return metadata.hosts[metadata.last_requested_index++ % metadata.hosts.length]
                }
                return
            }
        }
    }

    #proxy(req: IncomingMessage, res: Response) {
        const target = this.#resolve(req.url, req.method.toUpperCase())
        if (!target) {
            return res.json({
                error: {
                    code: target === null ? 'MICROSERVICE_OFFLINE' : 'SERVICE_NOT_FOUND'
                }
            })
        }
        const [host, port] = target.split(':')
        const options: http.RequestOptions = {
            host,
            port: Number(port || 80),
            path: req.url,
            method: req.method.toUpperCase(),
            headers: req.headers,
            insecureHTTPParser: true
        }


        req.pipe(
            http.request(options, (response) => {
                response.pipe(res)
            })
                .on('error', e => {
                    console.error(e)
                    res.json({ error: { code: "PROXY_ERROR" } })
                })
                .on('upgrade', (ireq, socket, head) => {
                })
        )
    }


    @Get()
    private get(@Request() req: IncomingMessage, @Res() res: Response) {
        return this.#proxy(req, res)
    }

    @Post()
    private post(@Request() req: IncomingMessage, @Res() res: Response) {
        return this.#proxy(req, res)
    }

    @Patch()
    private patch(@Request() req: IncomingMessage, @Res() res: Response) {
        return this.#proxy(req, res)
    }

    @Put()
    private put(@Request() req: IncomingMessage, @Res() res: Response) {
        return this.#proxy(req, res)
    }

    @Delete()
    private del(@Request() req: IncomingMessage, @Res() res: Response) {
        return this.#proxy(req, res)
    }

}

