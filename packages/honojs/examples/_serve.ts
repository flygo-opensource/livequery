import * as http from 'http'
import type { AddressInfo } from 'net'
import type { Hono } from 'hono'

export type ServedHonoApp = {
    server: http.Server
    port: number
    url: string
}

export function serveHono(app: Hono, port: number): Promise<ServedHonoApp> {
    return new Promise(resolve => {
        const server = http.createServer((req, res) => {
            app.fetch(toRequest(req)).then(async response => {
                res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
                res.end(Buffer.from(await response.arrayBuffer()))
            }).catch(error => {
                res.writeHead(500, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: String(error) }))
            })
        })

        server.listen(port, () => {
            const actualPort = (server.address() as AddressInfo).port
            resolve({
                server,
                port: actualPort,
                url: `http://127.0.0.1:${actualPort}`,
            })
        })
    })
}

function toRequest(req: http.IncomingMessage): Request {
    const host = req.headers.host ?? '127.0.0.1'
    const method = req.method ?? 'GET'
    const body = method === 'GET' || method === 'HEAD'
        ? undefined
        : req as unknown as BodyInit

    return new Request(`http://${host}${req.url ?? '/'}`, {
        method,
        headers: req.headers as HeadersInit,
        body,
        duplex: body ? 'half' : undefined,
    } as RequestInit)
}
