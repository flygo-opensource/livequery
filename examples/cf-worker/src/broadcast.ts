import type { Context } from 'hono'
import type { UpdatedData } from '@livequery/core/workers'
import { createRealtime } from './createRealtime.js'
import type { AppEnv } from './types.js'

/**
 * Publish a change after the response is sent. `waitUntil` keeps the Worker alive until every
 * shard has it; without it the runtime may cancel the fan-out once the response returns.
 */
export function broadcast(c: Context<AppEnv>, update: UpdatedData): void {
    const { publisher } = createRealtime(c.env)
    c.executionCtx.waitUntil(publisher.publish(update).catch(e => {
        console.error(JSON.stringify({ event: 'realtime_publish_failed', ref: update.ref, message: String(e) }))
    }))
}
