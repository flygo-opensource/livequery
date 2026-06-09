/**
 * Edge runtime WebSocket adapter — uses the standard `WebSocketPair` upgrade
 * pattern available in Cloudflare Workers, Deno Deploy, Vercel Edge, etc.
 *
 * Import via `@livequery/core/workers`.
 *
 *   export default {
 *     fetch(request, env, ctx) {
 *       if (new URL(request.url).pathname === '/livequery/realtime-updates') {
 *         return gateway.handleRequest(request)
 *       }
 *       return new Response('Not found', { status: 404 })
 *     }
 *   }
 *
 * Note: each Worker invocation gets its own gateway instance. For production
 * use you typically host the gateway in a Durable Object so state survives
 * across requests.
 */
import { WebsocketGatewayBase, SocketLike } from './WebsocketGatewayBase.js'

// `WebSocketPair` is a Web standard available on edge runtimes — declare it so
// this file can be type-checked under `@types/node` without DOM lib.
declare class WebSocketPair {
    0: any
    1: any
}

type EdgeWebSocket = {
    accept(): void
    send(data: string): void
    close(code?: number, reason?: string): void
    addEventListener(event: 'message', h: (e: { data: string }) => void): void
    addEventListener(event: 'close' | 'error', h: () => void): void
}

export class EdgeWebsocketGateway extends WebsocketGatewayBase {

    /** Call from your Worker `fetch()` handler with the upgrade request. */
    handleRequest(request: Request): Response {
        if (request.headers.get('Upgrade') !== 'websocket') {
            return new Response('Expected WebSocket', { status: 426 })
        }

        const Pair = (globalThis as { WebSocketPair?: typeof WebSocketPair }).WebSocketPair
        if (!Pair) {
            return new Response('WebSocketPair not available in this runtime', { status: 500 })
        }

        const pair = new Pair()
        const client: any = pair[0]
        const server = pair[1] as EdgeWebSocket
        server.accept()

        const socket: SocketLike = {
            send: (d) => server.send(d),
            close: () => server.close(),
            id: '',
            gateway: false,
            refs: new Set<string>(),
        }
        server.addEventListener('message', (e) => this.onMessage(socket, e.data))
        server.addEventListener('close', () => this.onClose(socket))
        server.addEventListener('error', () => this.onClose(socket))
        this.onConnection(socket)

        return new Response(null, { status: 101, webSocket: client } as any)
    }
}
