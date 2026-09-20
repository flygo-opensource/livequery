import { CloudflareRealtimePublisher, CloudflareRealtimeRouter } from '@livequery/core/workers'
import type { Env } from './types.js'

const DEFAULT_SHARDS = 4
const MAX_SHARDS = 64

// FNV-1a: a stable, cheap hash so one principal always lands on the same shard across reconnects.
function hash(value: string): number {
    let h = 0x811c9dc5
    for (let i = 0; i < value.length; i++) {
        h ^= value.charCodeAt(i)
        h = Math.imul(h, 0x01000193)
    }
    return h >>> 0
}

function shardNames(env: Env): string[] {
    const count = Number(env.REALTIME_SHARDS ?? DEFAULT_SHARDS)
    const n = Number.isInteger(count) && count > 0 ? Math.min(count, MAX_SHARDS) : DEFAULT_SHARDS
    return Array.from({ length: n }, (_, i) => `shard-${i}`)
}

/**
 * Realtime wiring for this Worker. A client socket lives on the shard picked from its principal;
 * subscriptions go straight to the gateway named by `x-lgid`; a change is published to every shard
 * because any of them may hold subscribers for the ref.
 */
export function createRealtime(env: Env) {
    const shards = shardNames(env)
    return {
        router: new CloudflareRealtimeRouter(env.GATEWAY, {
            shardKey: (_request, principal) => shards[hash(principal ?? '') % shards.length],
        }),
        publisher: new CloudflareRealtimePublisher(env.GATEWAY, { shards: () => shards }),
    }
}
