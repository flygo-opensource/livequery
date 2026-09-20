import type { Context, Env } from 'hono'
import type { RealtimeSubscription, UpdatedData, WebsocketGatewayBase } from '@livequery/core'

/**
 * Where a successful read registers its realtime subscription.
 *
 * - An in-process realtime gateway (`WebsocketGateway` on Node, `BunWebsocketGateway` on Bun, any
 *   `WebsocketGatewayBase`). The subscription is registered synchronously.
 * - A function, for runtimes where the socket lives elsewhere. On Cloudflare Workers:
 *   `(sub, c) => publisher.register(sub, c.get('principal'))`. It is awaited before the response
 *   is sent, so no change can slip between the read and the registration.
 */
export type LivequeryRealtimeSubscriber<E extends Env = any> =
    | Pick<WebsocketGatewayBase, 'id' | 'listen'>
    | ((subscription: RealtimeSubscription, c: Context<E>) => unknown)

/** Receives the changes a datasource watcher emits, usually the service's realtime gateway. */
export type LivequeryRealtimeSink = {
    next(update: UpdatedData): void
}
