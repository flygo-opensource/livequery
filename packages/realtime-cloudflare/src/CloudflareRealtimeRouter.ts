export type DurableObjectId = unknown

export interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): DurableObjectStubLike
}

export type CloudflareRealtimeRouterOptions = {
  /** Must return a bounded shard such as tenant, room, document, or bucket. */
  shardKey(request: Request): string | Promise<string>
}

/** Stateless Worker-side router. The Durable Object owns WebSocket state. */
export class CloudflareRealtimeRouter {
  readonly #namespace: DurableObjectNamespaceLike
  readonly #shardKey: CloudflareRealtimeRouterOptions['shardKey']

  constructor(namespace: DurableObjectNamespaceLike, options: CloudflareRealtimeRouterOptions) {
    this.#namespace = namespace
    this.#shardKey = options.shardKey
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 })
    }
    const shard = await this.#shardKey(request)
    if (!shard || shard.length > 256) {
      return Response.json({ error: { code: 'INVALID_REALTIME_SHARD', message: 'Invalid realtime shard key' } }, { status: 400 })
    }
    return this.#namespace.get(this.#namespace.idFromName(shard)).fetch(request)
  }
}
