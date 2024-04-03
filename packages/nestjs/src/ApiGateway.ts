import { Controller, Delete, Get, Inject, Optional, Patch, Post, Put, Request, Res, } from '@nestjs/common'
import * as https from 'http';
import { Response } from 'express';
import { IncomingMessage } from 'http';
import { LivequeryWebsocketSync } from './LivequeryWebsocketSync.js';
import { Observable, mergeMap } from 'rxjs'
import { ApiGatewayConnector } from './ApiGatewayConnector.js';



export type Routing = {
    [ref: string]: {
        dpaths: string[]
        children?: Routing
        methods?: {
            [METHOD: string]: {
                hosts: string[]
                last_index: number
            }
        }
    }
}



export type ServiceApiStatusMetadata = {
    host: string
    port: number
    http_paths: Array<{ method: string, path: string }>,
    ws_path?: string
}
export type ServiceApiStatus = {
    id: string
    online: boolean
    metadata?: ServiceApiStatusMetadata
} | { id: string, online: false }

export type ApiGatewayConnectorServiceStream = {
    $watch: () => Observable<{
        id: string,
        online: boolean,
    }>
    $node_id: (id: string) => {
        list: ApiGatewayConnector['list']
    }
}
export const ApiGatewayConnectorServiceStream = Symbol.for('ApiGatewayConnectorServiceStream')


@Controller(`*`)
export class ApiGateway {

    #services = new Map<string, ServiceApiStatusMetadata>
    #routing: Routing = {}

    constructor(
        @Inject(ApiGatewayConnector) private ApiGatewayConnector: ApiGatewayConnectorServiceStream,
        @Optional() private LivequeryWebsocketSync: LivequeryWebsocketSync
    ) {
        ApiGatewayConnector.$watch().pipe(
            mergeMap(async node => {
                // Manual find port because not every transporter have IP
                if (node.online) {
                    const { ip_address, ...r } = await ApiGatewayConnector.$node_id(node.id).list()
                    const host = '' // Try to find host here
                    const metadata = { ...r, host }
                    this.#services.set(node.id, metadata)
                    this.#join(metadata)
                }
                else {
                    const service = this.#services.get(node.id)
                    if (!service) return
                    this.#disconnect(service)
                    this.#services.delete(node.id)
                }
            })
        )
    }


    #disconnect({ host, http_paths, port, ws_path }: ServiceApiStatusMetadata) {
        const hostname = `${host}:${port}`
        for (
            let routes = [this.#routing];
            routes.length > 0;
            routes = routes.map(c => [...Object.values(c)].map(c => c.children).filter(c => !!c)).flat(2)
        ) {
            for (const route of routes) {
                for (const { methods } of Object.values(route)) {
                    for (const list of Object.values(methods)) {
                        if (list?.hosts.includes(hostname)) {
                            list.hosts = list?.hosts.filter(h => h != hostname)
                        }
                    }
                }
            }
        }
    }

    #join({ host, http_paths, port, ws_path }: ServiceApiStatusMetadata) {
        const hostname = `${host}:${port}`
        ws_path && this.LivequeryWebsocketSync?.connect(`ws://${hostname}${http_paths}`)
        for (const { method, path } of http_paths) {

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
                            last_index: 0
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
        console.log(`Find host for ${method}|${path}`)
        for (
            let cur = refs.shift(), routes = this.#match({ dpaths: [], children: this.#routing }, cur);
            cur != undefined && routes;
            cur = refs.shift(), routes = this.#match(routes, cur)
        ) {
            console.log(JSON.stringify({ cur, refs, routes }, null, 2))
            if (refs.length == 0) {
                const metadata = routes.methods?.[method]
                if (metadata) {
                    if (metadata.hosts.length == 0) return null
                    return metadata.hosts[metadata.last_index++ % metadata.hosts.length]
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
        const options: https.RequestOptions = {
            host,
            port: Number(port || 80),
            path: req.url,
            method: req.method.toUpperCase(),
            headers: req.headers,
            insecureHTTPParser: true
        }


        req.pipe(
            https.request(options, (response) => {
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

