/**
 * Bun WebSocket adapter — uses `Bun.serve()`.
 *
 * Import via `@livequery/core/bun`.
 *
 *   const gw = new BunWebsocketGateway()
 *   gw.listen(15535)                        // start a standalone Bun.serve
 *
 *   // or inside a framework (Hono, Elysia) that already owns Bun.serve:
 *   Bun.serve({
 *     fetch(req, server) {
 *       if (new URL(req.url).pathname === '/livequery/realtime-updates') {
 *         if (gw.attachBunUpgrade(req, server)) return
 *       }
 *       return new Response('Not found', { status: 404 })
 *     },
 *     websocket: gw.getBunWebsocketHandlers(),
 *   })
 */
import { WebsocketGatewayBase, SocketLike } from './WebsocketGatewayBase.js'
import { WEBSOCKET_PATH } from './const.js'

type BunSocketData = {
    id: string
    gateway: boolean
    refs: Set<string>
    _livequery?: boolean
}

type BunServer = { stop(closeActiveConnections?: boolean): void }
type BunWs = {
    data: BunSocketData
    send(data: string): void
    close(): void
}

const Bun = (globalThis as { Bun?: any }).Bun

export class BunWebsocketGateway extends WebsocketGatewayBase {
    #server?: BunServer

    constructor(port?: number) {
        super()
        if (port !== undefined) this.serve(port)
    }

    /** Start a standalone Bun.serve on the given port. */
    serve(port: number): this {
        if (!Bun) throw new Error('BunWebsocketGateway requires the Bun runtime')
        this.#server?.stop(true)
        this.#server = Bun.serve({
            port,
            fetch: (req: Request, server: any) => this.#fetch(req, server),
            websocket: this.getBunWebsocketHandlers(),
        }) as BunServer
        return this
    }

    /** Use inside an existing Bun.serve `fetch()` to upgrade livequery requests. */
    attachBunUpgrade(req: Request, server: any): boolean {
        return server.upgrade(req, {
            data: this.#newData(true),
        })
    }

    /** Spread into `Bun.serve({ websocket: ... })` when sharing a server. */
    getBunWebsocketHandlers() {
        const self = this
        return {
            open(ws: BunWs) {
                if (!ws.data?._livequery) return
                self.onConnection(self.#wrap(ws))
            },
            message(ws: BunWs, data: string | Buffer) {
                if (!ws.data?._livequery) return
                self.onMessage(self.#wrap(ws), data as any)
            },
            close(ws: BunWs) {
                if (ws.data?._livequery) self.onClose(self.#wrap(ws))
            },
            error(ws: BunWs) {
                if (ws.data?._livequery) self.onClose(self.#wrap(ws))
            },
        }
    }

    override close(): void {
        this.#server?.stop(true)
        this.#server = undefined
        super.close()
    }

    // ── Internal ───────────────────────────────────────────────────────────────

    #fetch(req: Request, server: any): Response | undefined {
        if (new URL(req.url).pathname === WEBSOCKET_PATH) {
            if (server.upgrade(req, { data: this.#newData(true) })) return
        }
        return new Response('Not found', { status: 404 })
    }

    #newData(livequery = true): BunSocketData {
        return {
            id: '',
            gateway: false,
            refs: new Set<string>(),
            _livequery: livequery,
        }
    }

    #wrap(ws: BunWs): SocketLike {
        return {
            send: (d) => ws.send(d),
            close: () => ws.close(),
            get id() { return ws.data.id },
            set id(v) { ws.data.id = v },
            get gateway() { return ws.data.gateway },
            set gateway(v) { ws.data.gateway = v },
            get refs() { return ws.data.refs },
            set refs(v) { ws.data.refs = v },
        }
    }
}
