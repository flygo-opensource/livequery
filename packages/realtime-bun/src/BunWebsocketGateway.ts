import { WebsocketGatewayBase, type SocketLike } from '@livequery/realtime'
import { LIVEQUERY_REALTIME_PATH } from '@livequery/protocol'

type BunSocketData = { id: string; gateway: boolean; refs: Set<string>; livequery: true }
type BunServer = { stop(closeActiveConnections?: boolean): void }
type BunSocket = {
  data: BunSocketData
  send(data: string): void
  close(): void
}
type BunUpgradeServer = {
  upgrade(request: Request, options: { data: BunSocketData }): boolean
}
type BunRuntime = { serve(options: Record<string, unknown>): BunServer }

/** Bun.serve transport for the Livequery realtime protocol. */
export class BunWebsocketGateway extends WebsocketGatewayBase {
  #server?: BunServer
  readonly path: string

  constructor(options: { port?: number; path?: string } = {}) {
    super()
    this.path = options.path ?? LIVEQUERY_REALTIME_PATH
    if (options.port !== undefined) this.serve(options.port)
  }

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

  attachBunUpgrade(request: Request, server: BunUpgradeServer): boolean {
    if (new URL(request.url).pathname !== this.path) return false
    return server.upgrade(request, { data: this.#newSocketData() })
  }

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

  #fetch(request: Request, server: BunUpgradeServer): Response | undefined {
    if (this.attachBunUpgrade(request, server)) return undefined
    return new Response('Not found', { status: 404 })
  }

  #newSocketData(): BunSocketData {
    return { id: '', gateway: false, refs: new Set<string>(), livequery: true }
  }

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
