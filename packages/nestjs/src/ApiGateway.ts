import { Controller, Delete, Get, Optional, Patch, Post, Put, Request, Res, } from '@nestjs/common'
import * as http from 'http';
import { type Response } from 'express';
import { IncomingMessage } from 'http';
import { LivequeryWebsocketSync } from './LivequeryWebsocketSync.js';
import { LIVEQUERY_API_GATEWAY_DEBUG } from './const.js';
import { RxjsUdp, UdpHello } from './RxjsUdp.js';
import { mergeMap, filter, debounceTime, groupBy } from 'rxjs/operators'
import { Subscription } from 'rxjs'

export type Routing = {
    [ref: string]: {
        dpaths: string[]
        children?: Routing
        methods?: {
            [METHOD: string]: {
                hosts: Array<{ uri: string, instance_id: string }>
                last_requested_index: number
            }
        }
    }
}



export type ServiceApiMetadata = {
    role: 'service' | 'gateway',
    name: string
    port: number
    paths: Array<{
        method: string,
        path: string
    }>
    websocket?: string
    wsauth?: string
    linked: string[]
    target?: string
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

    #services = new Map<string, { host: string, metadata: ServiceApiMetadata, subscription?: Subscription }>
    #routing: Routing = {}


    constructor(
        @Optional() private lws: LivequeryWebsocketSync
    ) {
        const udp = new RxjsUdp<ServiceApiMetadata>()

        udp.pipe(
            filter(m => m.role == 'service'),
            filter(m => !this.#services.has(m.sender_id)),
            groupBy(m => m.sender_id),
            mergeMap($ => $.pipe(
                debounceTime(1000),
                mergeMap(async e => {
                    await this.#join(e)
                })
            ))
        ).subscribe()

        setTimeout(() => {
            udp.broadcast({
                payload: {
                    name: 'API gateway',
                    paths: [],
                    port: 0,
                    role: 'gateway',
                    linked: [... this.#services.keys()]
                }
            })
        }, 1000)

    }


    async #join(metadata: UdpHello<ServiceApiMetadata>) {
        const host = metadata.host

        const hostname = `${host}:${metadata.port}`



        const subscription = metadata.websocket && this.lws?.connect(
            `ws://${hostname}${metadata.websocket}`,
            metadata.wsauth,
            () => this.#disconnect(metadata.sender_id)
        )

        this.#services.set(metadata.sender_id, { metadata, subscription, host })
        LIVEQUERY_API_GATEWAY_DEBUG && console.info(`[${new Date().toLocaleString()}] Service API online: ${metadata.name} at ${host}:${metadata.port}`)
        // LIVEQUERY_API_GATEWAY_DEBUG && console.info(`[${new Date().toLocaleString()}] Service websocket online: ${metadata.name} at ${host}:${metadata.port}${metadata.websocket}`)
        for (const { method, path } of metadata.paths || []) {

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
                            hosts: [],
                            last_requested_index: 0
                        }
                    }
                    methods[METHOD].hosts.push({ uri: hostname, instance_id: metadata.sender_id })
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

    async  #disconnect(id: string) {
        const service = this.#services.get(id)
        if (!service) return
        const { metadata, subscription, host } = service
        subscription.unsubscribe()
        LIVEQUERY_API_GATEWAY_DEBUG && console.error(`[${new Date().toLocaleString()}] Service API OFFLINE: ${metadata.name} at ${host}:${metadata.port}`)
        // LIVEQUERY_API_GATEWAY_DEBUG && console.error(`Service websocket OFFLINE: ${metadata.name} at ${host}:${metadata.port}${metadata.websocket}`)
        this.#services.delete(id)
        const hostname = `${host}:${metadata.port}`
        for (
            let routes = [this.#routing];
            routes.length > 0;
            routes = routes.map(c => [...Object.values(c)].map(c => c.children).filter(c => !!c)).flat(2)
        ) {
            for (const route of routes) {
                for (const { methods } of Object.values(route || {})) {
                    for (const list of Object.values(methods || {})) {
                        list.hosts = list.hosts.filter(h => h.instance_id != id || h.uri != hostname)
                    }
                }
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

    #proxy(req: IncomingMessage & { rawBody: Buffer, body?: any }, res: Response) {

        if (Number(req.headers['content-length'] || 0) > 0 && !req.rawBody) {
            res.status(500)
            return res.json({
                error: {
                    status: 500,
                    code: "MISISNG_API_GATEWAY_RAW_BODY",
                    message: `Please enable rawBody = true in NestFactory.create()`
                }
            });
        }


        const target = this.#resolve(req.url, req.method.toUpperCase())
        if (!target) {
            const status = target === null ? 500 : 404
            res.status(status)
            return res.json({
                error: {
                    status,
                    code: status == 500 ? 'MICROSERVICE_OFFLINE' : 'API_NOT_FOUND'
                }
            })
        }
        const [host, port] = target.uri.split(':')
        const client_id = req.headers['x-lcid'] || req.headers['socket_id']

        const { "content-length": _, ...headers } = {
            ...req.headers,
            ...client_id && this.lws ? {
                'x-lcid': client_id,
                'x-lgid': req.headers['x-lgid'] || this.lws?.id || ''
            } : {}
        }

        const options: http.RequestOptions = {
            host,
            port: Number(port || 80),
            path: req.url,
            method: req.method.toUpperCase(),
            headers
        }
        const proxy_request = http.request(options);
        proxy_request
            .on('error', (e: NodeJS.ErrnoException) => {
                e.code == 'ECONNREFUSED' && this.#disconnect(target.instance_id);
                res.json({ error: { code: "SERVICE_API_OFFLINE" } });
            })
            .on('upgrade', (ireq, socket, head) => {

            })
            .on('response', response => {
                res.status(response.statusCode)
                for (const [k, v] of Object.entries(response.headers || {})) {
                    res.setHeader(k, v)
                }
                response.pipe(res)
            })

        proxy_request.write(req.rawBody || Buffer.alloc(0), e => {
            proxy_request.end()
        })

    }

    @Get()
    private get(@Request() req: IncomingMessage & { rawBody: Buffer }, @Res() res: Response) {
        return this.#proxy(req, res)
    }

    @Post()
    private post(@Request() req: IncomingMessage & { rawBody: Buffer }, @Res() res: Response) {
        return this.#proxy(req, res)
    }

    @Patch()
    private patch(@Request() req: IncomingMessage & { rawBody: Buffer }, @Res() res: Response) {
        return this.#proxy(req, res)
    }

    @Put()
    private put(@Request() req: IncomingMessage & { rawBody: Buffer }, @Res() res: Response) {
        return this.#proxy(req, res)
    }

    @Delete()
    private del(@Request() req: IncomingMessage & { rawBody: Buffer }, @Res() res: Response) {
        return this.#proxy(req, res)
    }

}

