/**
 * Node.js build of `@livequery/honojs`, selected by the `node` export condition.
 *
 *   export default serve(app, { port: 8080, realtime: gateway })
 *
 * Node has no default-export server convention, so this one starts `http.createServer` itself and
 * returns the app for tests. A realtime gateway is attached to the same server, which is how it
 * shares the port with the HTTP API.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'

export * from '../index.js'
import type { FetchApp, ServeOptions } from './types.js'
export type { FetchApp, ServeOptions } from './types.js'

type NodeGateway = { attach(server: ReturnType<typeof createServer>): unknown }

function isNodeGateway(value: unknown): value is NodeGateway {
    return typeof (value as NodeGateway | undefined)?.attach === 'function'
}

function toRequest(req: IncomingMessage): Request {
    const host = req.headers.host ?? '127.0.0.1'
    const has_body = req.method !== 'GET' && req.method !== 'HEAD'
    return new Request(`http://${host}${req.url ?? '/'}`, {
        method: req.method ?? 'GET',
        headers: req.headers as HeadersInit,
        // Node's web-stream type is runtime-compatible with fetch but not with the DOM lib type.
        body: has_body ? Readable.toWeb(req) as unknown as BodyInit : undefined,
        duplex: has_body ? 'half' : undefined,
    } as RequestInit)
}

async function write(res: ServerResponse, response: Response): Promise<void> {
    const headers: Record<string, string> = {}
    response.headers.forEach((value, key) => { headers[key] = value })
    res.writeHead(response.status, headers)
    res.end(Buffer.from(await response.arrayBuffer()))
}

export function serve(app: FetchApp, options: ServeOptions = {}): FetchApp {
    const server = createServer((req, res) => {
        void (async () => {
            try {
                await write(res, await app.fetch(toRequest(req)))
            } catch (e) {
                console.error('livequery: request failed', e)
                res.writeHead(500, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'Internal error' } }))
            }
        })()
    })

    if (isNodeGateway(options.realtime)) options.realtime.attach(server)
    server.listen(options.port ?? 8080)
    return app
}
