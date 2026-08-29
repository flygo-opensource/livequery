/**
 * Node.js WebSocket adapter — uses the `ws` package as the transport.
 *
 * Default export of `@livequery/core` for backward compatibility (this is the
 * adapter most existing consumers were using). For an explicit import use
 * `@livequery/core/node`.
 *
 * Lifecycle:
 *   - `new WebsocketGateway()`           — protocol ready, no server attached
 *   - `new WebsocketGateway(httpServer)` — attached immediately (legacy form)
 *   - `gateway.attach(httpServer)`        — attach (or replace) at any time
 *   - `gateway.close()`                   — disposes both protocol and server
 */
import { WebSocket, WebSocketServer } from 'ws'
import type { Server as HttpServer } from 'http'
import { WebsocketGatewayBase, type SocketLike, type WebsocketGatewayOptions } from '@livequery/realtime'
import { LIVEQUERY_REALTIME_PATH } from '@livequery/protocol'

const HTTP_SERVER_GATEWAYS = Symbol.for('livequery.websocket_gateways')
const HTTP_SERVER_CLOSE_PATCHED = Symbol.for('livequery.websocket_close_patched')

type PatchedHttpServer = HttpServer & {
    [HTTP_SERVER_GATEWAYS]?: Set<WebsocketGateway>
    [HTTP_SERVER_CLOSE_PATCHED]?: boolean
}

export class WebsocketGateway extends WebsocketGatewayBase {
    #wss?: WebSocketServer
    #httpServer?: HttpServer

    constructor(server?: HttpServer, options?: WebsocketGatewayOptions) {
        super(options)
        if (server) this.attach(server)
    }

    /**
     * Bind (or rebind) the gateway to an `http.Server`. Closes any previously
     * attached server. Safe to call repeatedly.
     */
    attach(server: HttpServer): this {
        this.#detachServer()
        this.#wss = new WebSocketServer({ server, path: LIVEQUERY_REALTIME_PATH, perMessageDeflate: false })
        this.#httpServer = server
        this.#patchHttpServerClose(server)

        this.#wss.on('connection', (ws: WebSocket) => {
            const socket: SocketLike = {
                send: (d) => ws.send(d),
                close: () => ws.close(),
                isAlive: () => ws.readyState === WebSocket.OPEN,
                id: '',
                gateway: false,
                refs: new Set<string>(),
            }
            ws.on('message', (raw) => this.onMessage(socket, raw as Buffer))
            ws.on('close', () => this.onClose(socket))
            ws.on('error', () => this.onClose(socket))
            this.onConnection(socket)
        })
        return this
    }

    override close(): void {
        this.#detachServer()
        super.close()
    }

    #detachServer(): void {
        const wss = this.#wss
        const httpServer = this.#httpServer as PatchedHttpServer | undefined
        this.#wss = undefined
        this.#httpServer = undefined
        httpServer?.[HTTP_SERVER_GATEWAYS]?.delete(this)
        if (wss) {
            for (const client of wss.clients) client.close()
            wss.close()
        }
    }

    #patchHttpServerClose(server: HttpServer): void {
        const target = server as PatchedHttpServer
        const gateways = target[HTTP_SERVER_GATEWAYS] ?? new Set<WebsocketGateway>()
        gateways.add(this)
        target[HTTP_SERVER_GATEWAYS] = gateways

        if (target[HTTP_SERVER_CLOSE_PATCHED]) return

        const close = server.close.bind(server)
        target.close = ((...args: Parameters<HttpServer['close']>) => {
            for (const gateway of gateways) {
                gateway.close()
            }
            server.closeAllConnections?.()
            return close(...args)
        }) as HttpServer['close']
        target[HTTP_SERVER_CLOSE_PATCHED] = true
    }
}

