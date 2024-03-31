import { Controller, Delete, Get, Patch, Post, Put, Request, Res, } from '@nestjs/common'
import * as https from 'http';
import { Response } from 'express';
import { IncomingMessage } from 'http';



export type Routing = Map<string, Partial<{
    children: Routing
    methods: Map<string, {
        hosts: string[]
        last_index: number
    }>
}>>


@Controller(`${process.env.API_GATEWAY_PREFIX || 'livequery'}/*`)
export class ApiGateway {

    #routing: Routing = new Map()

    disconnect(host: string) {
        for (
            let routes = [this.#routing];
            routes.length > 0;
            routes = routes.map(c => [...c.values()].map(c => c.children).filter(c => !!c)).flat(2)
        ) {
            for (const route of routes) {
                for (const { methods } of route.values()) {
                    for (const list of methods.values()) {
                        if (list?.hosts.includes(host)) {
                            list.hosts = list?.hosts.filter(h => h != host)
                        }
                    }
                }
            }
        }
    }

    connect(host: string, paths: Array<{ method: string, path: string }>) {

        for (const { method, path } of paths) {

            const refs = path.split('/').map(r => r.startsWith(':') ? ':' : r)

            for (
                let routes = this.#routing, ref = refs.shift();
                refs.length > 0;
                routes = routes.get(ref).children
            ) {
                if (!routes.has(ref)) {
                    routes.set(ref, {
                        methods: new Map(),
                        children: new Map()
                    })
                }

                if (refs.length > 0) continue

                const methods = routes.get(ref).methods
                const metadata = methods.get(method.toUpperCase())
                if (!metadata) {
                    methods.set(method.toUpperCase(), {
                        hosts: [host],
                        last_index: 0
                    })
                    continue
                }

                metadata[0].hosts.push(host)

            }

        }
    }

    #resolve(path: string, method: string) {
        const refs = path.split('/')
        for (
            let cur = refs.shift(), routes = this.#routing.get(cur) || this.#routing.get(':');
            refs.length == 0 && routes;
            cur = refs.shift(), routes = routes.children?.get(cur) || routes.children?.get(':')
        ) {
            if (refs.length == 0 && routes) {
                const metadata = routes.methods?.get(method)?.[0]
                if (metadata) {
                    return metadata.hosts[metadata.last_index++ % metadata.hosts.length]
                }
            }
        }
    }


    #proxy(req: IncomingMessage, res: Response) {
        const hostname = this.#resolve(req.url, req.method.toUpperCase())
        if (!hostname) {
            return res.sendStatus(404).json({
                error: {
                    code: 'NOT_FOUND'
                }
            })
        }
        const options: https.RequestOptions = {
            hostname,
            port: 80,
            path: req.url,
            method: req.method.toUpperCase(),
            headers: req.headers,
            insecureHTTPParser: true
        }

        req.pipe(
            https.request(options, (response) => {
                res.writeHead(response.statusCode, response.headers)
                response.pipe(res)
            })
                .on('error', e => {
                    console.log(e)
                    res.sendStatus(500)
                    res.json({ error: { code: "PROXY_ERROR" } })
                })
                .on('upgrade', (ireq, socket, head) => {
                    console.log({ ireq, socket, head })
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

