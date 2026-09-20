/**
 * Bun WebSocket adapter — uses `Bun.serve()`.
 *
 * Import via `@livequery/core/bun`.
 *
 *   const gw = new BunWebsocketGateway({ port: 15535 })   // standalone Bun.serve
 *
 *   // or inside a framework (Hono, Elysia) that already owns Bun.serve:
 *   Bun.serve({
 *     fetch(req, server) {
 *       if (gw.attachBunUpgrade(req, server)) return
 *       return new Response('Not found', { status: 404 })
 *     },
 *     websocket: gw.getBunWebsocketHandlers(),
 *   })
 */
import { WEBSOCKET_PATH } from './const.js'
import { WebsocketGatewayBase, type SocketLike, type WebsocketGatewayOptions } from './WebsocketGatewayBase.js'

export type BunWebsocketGatewayOptions = WebsocketGatewayOptions & {
    /** Start a standalone `Bun.serve` on this port. */
    port?: number
    /** Upgrade path. Default `WEBSOCKET_PATH` (`/livequery/realtime-updates`). */
    path?: string
}

type BunSocketData = { id: string; gateway: boolean; refs: Set<string>; livequery: true }

type BunSocket = {
    data: BunSocketData
    send(data: string): void
    close(): void
}

type BunServer = { stop(closeActiveConnections?: boolean): void }

type BunUpgradeServer = {
    upgrade(request: Request, options: { data: BunSocketData }): boolean
}

type BunRuntime = { serve(options: Record<string, unknown>): BunServer }

export class BunWebsocketGateway extends WebsocketGatewayBase {
    readonly path: string

    #server?: BunServer

    /** Pass a port number (legacy form) or options. */
    constructor(options: number | BunWebsocketGatewayOptions = {}) {
        const { port, path, ...gateway_options } = typeof options === 'number' ? { port: options } : options
        super(gateway_options)
        this.path = path ?? WEBSOCKET_PATH
        if (port !== undefined) this.serve(port)
    }

    /** Start a standalone Bun.serve on the given port. */
    serve(port: number): this {
        const runtime = (globalThis as unknown as { Bun?: BunRuntime }).Bun
        if (!runtime) throw new Error('BunWebsocketGateway requires the Bun runtime')
        this.#server?.stop(true)
        this.#server = runtime.serve({
            port,
            fetch: (request: Request, server: BunUpgradeServer) => this.#fetch(request, server),
            websocket: this.getBunWebsocketHandlers(),
        })
        return this
    }

    /**
     * Use inside an existing Bun.serve `fetch()`. Upgrades requests to `path` and returns true;
     * returns false for any other path so the caller can handle it.
     */
    attachBunUpgrade(request: Request, server: BunUpgradeServer): boolean {
        if (new URL(request.url).pathname !== this.path) return false
        return server.upgrade(request, { data: this.#newSocketData() })
    }

    /** Spread into `Bun.serve({ websocket: ... })` when sharing a server. */
    getBunWebsocketHandlers() {
        return {
            open: (socket: BunSocket) => {
                if (socket.data?.livequery) this.onConnection(this.#wrap(socket))
            },
            message: (socket: BunSocket, data: string | ArrayBuffer | Uint8Array) => {
                if (socket.data?.livequery) this.onMessage(this.#wrap(socket), data)
            },
            close: (socket: BunSocket) => {
                if (socket.data?.livequery) this.onClose(this.#wrap(socket))
            },
            error: (socket: BunSocket) => {
                if (socket.data?.livequery) this.onClose(this.#wrap(socket))
            },
        }
    }

    override close(): void {
        this.#server?.stop(true)
        this.#server = undefined
        super.close()
    }

    // ── Internal ───────────────────────────────────────────────────────────────

    #fetch(request: Request, server: BunUpgradeServer): Response | undefined {
        if (this.attachBunUpgrade(request, server)) return undefined
        return new Response('Not found', { status: 404 })
    }

    #newSocketData(): BunSocketData {
        return { id: '', gateway: false, refs: new Set<string>(), livequery: true }
    }

    // Identity lives on socket.data, so every wrapper of the same socket sees the same state.
    #wrap(socket: BunSocket): SocketLike {
        return {
            send: data => socket.send(data),
            close: () => socket.close(),
            get id() { return socket.data.id },
            set id(value) { socket.data.id = value },
            get gateway() { return socket.data.gateway },
            set gateway(value) { socket.data.gateway = value },
            get refs() { return socket.data.refs },
            set refs(value) { socket.data.refs = value },
        }
    }
}
