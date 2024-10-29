import { Controller, Delete, Get, Optional, Patch, Post, Put, Request, Res, } from '@nestjs/common'
import * as http from 'http';
import { Response } from 'express';
import { IncomingMessage } from 'http';
import { LivequeryWebsocketSync } from './LivequeryWebsocketSync.js';
import { API_GATEWAY_NAMESPACE } from './const.js';
import { RxjsUdp } from './RxjsUdp.js';
import { mergeMap } from 'rxjs/operators'
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

    #services = new Map<string, { metadata: ServiceApiMetadata, subscription?: Subscription }>
    #routing: Routing = {}
    #udp = new RxjsUdp()

    constructor(
        @Optional() private LivequeryWebsocketSync: LivequeryWebsocketSync
    ) {
        this.#udp = new RxjsUdp()
        this.#udp.pipe(
            mergeMap(async ({ host, port }) => {
                const r: { data: ServiceApiMetadata } = await fetch(`http://${host}:${port}/api-gateway/metadata`).then(r => r.json())
                r.data && r.data.namespace == API_GATEWAY_NAMESPACE && this.#join({ ...r.data, host })
            })
        ).subscribe()
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

    async #join(metadata: ServiceApiMetadata) {
        if (this.#services.has(metadata.id)) return
        const hostname = `${metadata.host}:${metadata.port}`

        const subscription = metadata.websocket ? this.LivequeryWebsocketSync?.connect(
            `ws://${hostname}${metadata.websocket}`,
            () => this.#disconnect(metadata.id)
        ) : undefined

        this.#services.set(metadata.id, { metadata, subscription })
        process.env.LIVEQUERY_API_GATEWAY_DEBUG && console.log(`Service API online: ${metadata.name} at ${metadata.host}:${metadata.port}`)
        metadata.websocket && process.env.LIVEQUERY_API_GATEWAY_DEBUG && console.log(`Service websocket online: ${metadata.name} at ${metadata.host}:${metadata.port}${metadata.websocket}`)
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
                            hosts: [],
                            last_requested_index: 0
                        }
                    }
                    methods[METHOD].hosts.push({ uri: hostname, instance_id: metadata.id })
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
        const { metadata, subscription } = service
        subscription.unsubscribe()
        process.env.LIVEQUERY_API_GATEWAY_DEBUG && console.log(`Service API OFFLINE: ${metadata.name} at ${metadata.host}:${metadata.port}`)
        process.env.LIVEQUERY_API_GATEWAY_DEBUG && console.log(`Service websocket OFFLINE: ${metadata.name} at ${metadata.host}:${metadata.port}${metadata.websocket}`)
        this.#services.delete(id)
        const hostname = `${metadata.host}:${metadata.port}`
        for (
            let routes = [this.#routing];
            routes.length > 0;
            routes = routes.map(c => [...Object.values(c)].map(c => c.children).filter(c => !!c)).flat(2)
        ) {
            for (const route of routes) {
                for (const { methods } of Object.values(route || {})) {
                    for (const list of Object.values(methods || {})) {
                        list.hosts = list.hosts.filter(h => h.uri != hostname)
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

    #proxy(req: IncomingMessage & { rawBody: Buffer }, res: Response) {

        if (!req.rawBody) {
            return res.json({
                error: {
                    code: "MISISNG_API_GATEWAY_RAW_BODY",
                    message: `Please enable rawBody = true in NestFactory.create(`
                }
            });
        }


        const target = this.#resolve(req.url, req.method.toUpperCase())
        if (!target) {
            return res.json({
                error: {
                    code: target === null ? 'MICROSERVICE_OFFLINE' : 'SERVICE_NOT_FOUND'
                }
            })
        }
        const [host, port] = target.uri.split(':')
        const options: http.RequestOptions = {
            host,
            port: Number(port || 80),
            path: req.url,
            method: req.method.toUpperCase(),
            headers: req.headers,
            insecureHTTPParser: true
        }

        const proxy_request = http.request(options, (response) => {
            for (const [k, v] of Object.entries(response.headers)) {
                res.setHeader(k, v)
            }
            response.pipe(res)
        });
        proxy_request
            .on('error', (e: NodeJS.ErrnoException) => {
                e.code == 'ECONNREFUSED' && this.#disconnect(target.instance_id);
                res.json({ error: { code: "SERVICE_API_OFFLINE" } });
            })
            .on('upgrade', (ireq, socket, head) => {
            })

        proxy_request.write(req.rawBody)

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

