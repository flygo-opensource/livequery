import type { UpdatedData } from '@livequery/core'
import type { RealtimeSubscription } from '@livequery/core/workers'

const DO_NAME = 'main'

function stub(gateway: DurableObjectNamespace) {
    return gateway.get(gateway.idFromName(DO_NAME))
}

/** Notify subscribed clients of a data change. */
export async function broadcast(gateway: DurableObjectNamespace, update: UpdatedData): Promise<void> {
    await stub(gateway).fetch(new Request('http://internal/broadcast', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(update),
    }))
}

/** Register a server-side subscription (called from HTTP GET handlers). */
export async function subscribe(gateway: DurableObjectNamespace, sub: RealtimeSubscription): Promise<void> {
    await stub(gateway).fetch(new Request('http://internal/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sub),
    }))
}

/** Derive the canonical Livequery ref from a table name and optional document id. */
export function toRef(table: string, id?: string): string {
    return id ? `${table}/${id}` : table
}
