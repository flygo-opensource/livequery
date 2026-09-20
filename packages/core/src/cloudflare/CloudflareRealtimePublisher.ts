import type { UpdatedData } from '../LivequeryBaseEntity.js'
import type { RealtimeSubscription } from '../LivequeryRealtime.js'
import {
    LIVEQUERY_DO_BROADCAST_PATH,
    LIVEQUERY_DO_SUBSCRIBE_PATH,
    LIVEQUERY_PRINCIPAL_HEADER,
} from './const.js'
import type { DurableObjectId, DurableObjectNamespaceLike } from './types.js'

export type CloudflareRealtimePublisherOptions = {
    /** Shard names whose Durable Objects may hold subscribers for this change. */
    shards(update: UpdatedData): string[] | Promise<string[]>
}

/**
 * Worker-side client for `HibernatableWebsocketGateway` Durable Objects.
 *
 *   const publisher = new CloudflareRealtimePublisher(env.REALTIME, { shards: () => ['main'] })
 *   await publisher.register({ ref, client_id, gateway_id, listener_node_id: gateway_id }, principal)
 *   ctx.waitUntil(publisher.publish({ ref, type: 'added', data: item }))
 */
export class CloudflareRealtimePublisher {
    readonly #namespace: DurableObjectNamespaceLike
    readonly #shards: CloudflareRealtimePublisherOptions['shards']

    constructor(namespace: DurableObjectNamespaceLike, options: CloudflareRealtimePublisherOptions) {
        this.#namespace = namespace
        this.#shards = options.shards
    }

    /** Deliver a change to every shard returned by `shards`. Rejects if any shard fails. */
    async publish(update: UpdatedData): Promise<void> {
        const shards = await this.#shards(update)
        const body = JSON.stringify(update)
        const responses = await Promise.all(shards.map(shard => this.#call(
            this.#namespace.idFromName(shard),
            LIVEQUERY_DO_BROADCAST_PATH,
            body,
        )))
        const failed = responses.filter(response => !response.ok).length
        if (failed > 0) throw new Error(`Realtime publish failed on ${failed} of ${shards.length} shards`)
    }

    /**
     * Register a subscription on the gateway named by `subscription.gateway_id` (the `x-lgid` the
     * client received in `hello`). Call it only after the read it subscribes to was authorized.
     * Resolves false when the gateway id is unknown or the client socket belongs to another principal.
     */
    async register(subscription: RealtimeSubscription, principal?: string): Promise<boolean> {
        const id = this.#idFromString(subscription.gateway_id)
        if (id === undefined) return false
        const response = await this.#call(id, LIVEQUERY_DO_SUBSCRIBE_PATH, JSON.stringify(subscription), principal)
        return response.ok
    }

    // ── Internal ───────────────────────────────────────────────────────────────

    #idFromString(gateway_id: string): DurableObjectId | undefined {
        if (!this.#namespace.idFromString) {
            throw new Error('register() requires a namespace with idFromString()')
        }
        try {
            return this.#namespace.idFromString(gateway_id)
        } catch {
            // Not an id of this namespace, e.g. a forged or stale x-lgid header.
            return undefined
        }
    }

    #call(id: DurableObjectId, path: string, body: string, principal?: string): Promise<Response> {
        const headers = new Headers({ 'content-type': 'application/json' })
        if (principal !== undefined) headers.set(LIVEQUERY_PRINCIPAL_HEADER, principal)
        return this.#namespace.get(id).fetch(new Request(`https://livequery.internal${path}`, {
            method: 'POST',
            headers,
            body,
        }))
    }
}
