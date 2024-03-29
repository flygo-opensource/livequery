import { Controller, Delete, Get, Patch, Post, Put, Request, Res, } from '@nestjs/common'
import * as https from 'http';
import { Response } from 'express';
import { createReadStream } from 'fs';
import { IncomingMessage } from 'http';

export type RefMap = {
    [path: string]: string | RefMap
}


@Controller('livequery/*')
export class ApiGateway {

    #paths = new Map<string, Array<{
        last_index: number
        version: number
        hosts: string[]
    }>>


    constructor() {

    }

    #get_path(ref: string) {
        return ref.split('/').map(v => v.startsWith(':') ? ':' : v).join('/')
    }

    disconnect(host: string) {
        for (const [path, versions] of this.#paths) {
            for (const ver of versions) {
                if (ver.hosts.includes(host)) {
                    ver.hosts = ver.hosts.filter(h => h != host)
                }
            }
            const updated_versions = versions.filter(ver => ver.hosts.length > 0)
            this.#paths.set(path, updated_versions)
        }
    }

    connect(host: string, refs: string[], version: number) {
        for (const ref of refs) {

            const path = this.#get_path(ref)
            !this.#paths.has(path) && this.#paths.set(path, [])
            const versions = this.#paths.get(path)


            if (versions.length == 0 || versions[0].version < version) {
                versions.unshift({
                    hosts: [host],
                    last_index: 0,
                    version
                })
                continue
            }

            if (versions[0].version == version) {
                versions[0].hosts.push(host)
                continue
            }

            versions.push({
                hosts: [host],
                last_index: 0,
                version
            })

        }
    }

    resolve(ref: string) { 
        return '128.199.217.97'
    }


    async proxy(req: IncomingMessage, res: Response) {
        const options: https.RequestOptions = {
            hostname: this.resolve(req.url),
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
    get(@Request() req: IncomingMessage, @Res() res: Response) {
        return this.proxy(req, res)
    }

    @Post()
    post(@Request() req: IncomingMessage, @Res() res: Response) {
        return this.proxy(req, res)
    }

    @Patch()
    patch(@Request() req: IncomingMessage, @Res() res: Response) {
        return this.proxy(req, res)
    }

    @Put()
    put(@Request() req: IncomingMessage, @Res() res: Response) {
        return this.proxy(req, res)
    }

    @Delete()
    del(@Request() req: IncomingMessage, @Res() res: Response) {
        return this.proxy(req, res)
    }

}

