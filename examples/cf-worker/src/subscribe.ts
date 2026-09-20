import type { Context } from 'hono'
import { createRealtime } from './createRealtime.js'
import type { AppEnv } from './types.js'

/**
 * Register the caller's socket for `ref`. Call only after the read of `ref` succeeded, and await it
 * before responding so no change can slip between the response and the registration.
 */
export async function subscribe(c: Context<AppEnv>, ref: string): Promise<void> {
    const client_id = c.req.header('x-lcid')
    const gateway_id = c.req.header('x-lgid')
    if (!client_id || !gateway_id) return

    const { publisher } = createRealtime(c.env)
    const subscription = { ref, client_id, gateway_id, listener_node_id: gateway_id }
    const accepted = await publisher.register(subscription, c.get('principal')).catch(e => {
        console.error(JSON.stringify({ event: 'realtime_subscribe_failed', ref, message: String(e) }))
        return false
    })
    if (!accepted) console.warn(JSON.stringify({ event: 'realtime_subscribe_rejected', ref }))
}
