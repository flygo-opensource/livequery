import { Controller, Delete, Get, Inject, Optional, Patch, Post, Put, Request, Res, } from '@nestjs/common'
import * as http from 'http';
import { Response } from 'express';
import { IncomingMessage } from 'http';
import { LivequeryWebsocketSync } from './LivequeryWebsocketSync.js';
import { Observable, mergeMap, firstValueFrom, from, map, tap, debounceTime, timer, filter, distinctUntilKeyChanged } from 'rxjs'
import { ApiGatewayConnector } from './ApiGatewayConnector.js';



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
    name: string
    port: number
    paths: Array<{
        method: string,
        path: string
    }>
    websocket?: string
}
export type ServiceApiStatus = {
    id: string
    online: boolean
    metadata?: ServiceApiMetadata
} | { id: string, online: false }

export type ApiGatewayConnectorService = {
    $watch: () => Observable<{
        id: string,
        online: boolean,
    }>
    $node_id: (id: string) => ApiGatewayConnector
}


@Controller(`*`)
export class ApiGateway {

    #services = new Map<string, { host: string, metadata: ServiceApiMetadata }>
    #routing: Routing = {}

    constructor(
        @Inject(ApiGatewayConnector) private ApiGatewayConnector: ApiGatewayConnectorService,
        @Optional() private LivequeryWebsocketSync: LivequeryWebsocketSync
    ) {
        ApiGatewayConnector.$watch().pipe(
            tap(node => !node.online && this.#disconnect(node.id)),
            filter(node => node.online),
            distinctUntilKeyChanged('id'),
            mergeMap(node => node.online ? this.#join(node.id) : null, 1)
        ).subscribe()
    }


    async  #disconnect(id: string) {
        const service = this.#services.get(id)
        if (!service) return
        process.env.LIVEQUERY_API_GATEWAY_DEBUG && console.log(`Service API OFFLINE: ${service.metadata.name} at ${service.host}:${service.metadata.port}`)
        process.env.LIVEQUERY_API_GATEWAY_DEBUG && console.log(`Websocket API OFFLINE: ${service.metadata.name} at ${service.host}:${service.metadata.port}${service.metadata.websocket}`)
        this.#services.delete(id)
        const hostname = `${service.host}:${service.metadata.port}`
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

    async  #find_api_host(hosts: string[], port: number, loop: number = 10) {
        for (let i = 1; i <= loop; i++) {
            for (const hostname of hosts) {
                const connected = await new Promise<boolean>(s => {
                    const request = http.request({
                        hostname,
                        port,
                        method: 'HEAD'
                    })
                    request.on('response', () => s(true))
                    request.on('error', () => s(false))
                    request.end()
                })
                if (connected) return hostname
                await firstValueFrom(timer(1000))
            }
        }
    }

    async #join(id: string) {
        const { ip_addresses, metadata } = await this.ApiGatewayConnector.$node_id(id).list()
        const host = await this.#find_api_host(ip_addresses, metadata.port)
        if (!host) return
        this.#services.set(id, { host, metadata })
        const hostname = `${host}:${metadata.port}`
        process.env.LIVEQUERY_API_GATEWAY_DEBUG && console.log(`Service API online: ${metadata.name} at ${host}:${metadata.port}`)
        process.env.LIVEQUERY_API_GATEWAY_DEBUG && console.log(`Websocket API online: ${metadata.name} at ${host}:${metadata.port}${metadata.websocket}`)
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
        const refs = path.split('/').slice(1)
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

