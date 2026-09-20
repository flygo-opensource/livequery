import { describe, expect, test } from 'bun:test'
import {
    CloudflareRealtimePublisher,
    CloudflareRealtimeRouter,
    LIVEQUERY_DO_BROADCAST_PATH,
    LIVEQUERY_DO_SUBSCRIBE_PATH,
    LIVEQUERY_PRINCIPAL_HEADER,
} from '../../src/workers.js'
import type { DurableObjectNamespaceLike } from '../../src/workers.js'

type Call = { id: string; path: string; principal: string | null; body: string; upgrade: string | null }

function makeNamespace(status = 204): DurableObjectNamespaceLike & { calls: Call[] } {
    const calls: Call[] = []
    return {
        calls,
        idFromName: name => `name:${name}`,
        idFromString: id => {
            if (!id.startsWith('do-')) throw new TypeError('Invalid Durable Object ID')
            return `id:${id}`
        },
        get: id => ({
            async fetch(request: Request) {
                calls.push({
                    id: String(id),
                    path: new URL(request.url).pathname,
                    principal: request.headers.get(LIVEQUERY_PRINCIPAL_HEADER),
                    upgrade: request.headers.get('Upgrade'),
                    body: request.method === 'POST' ? await request.text() : '',
                })
                return new Response(null, { status })
            },
        }),
    }
}

// ─── router ────────────────────────────────────────────────────────────────────

describe('CloudflareRealtimeRouter', () => {
    test('forwards the upgrade to its shard and replaces a client-sent principal', async () => {
        const namespace = makeNamespace()
        const router = new CloudflareRealtimeRouter(namespace, { shardKey: (_request, principal) => `u:${principal}` })
        await router.fetch(new Request('https://api/livequery/realtime-updates', {
            headers: { Upgrade: 'websocket', [LIVEQUERY_PRINCIPAL_HEADER]: 'forged' },
        }), 'alice')
        expect(namespace.calls[0]).toMatchObject({ id: 'name:u:alice', principal: 'alice', upgrade: 'websocket' })
    })

    test('strips a client-sent principal when the Worker has none', async () => {
        const namespace = makeNamespace()
        const router = new CloudflareRealtimeRouter(namespace, { shardKey: () => 'main' })
        await router.fetch(new Request('https://api/ws', {
            headers: { Upgrade: 'websocket', [LIVEQUERY_PRINCIPAL_HEADER]: 'forged' },
        }))
        expect(namespace.calls[0].principal).toBeNull()
    })

    test('non-upgrade request — 426 without reaching a Durable Object', async () => {
        const namespace = makeNamespace()
        const router = new CloudflareRealtimeRouter(namespace, { shardKey: () => 'main' })
        const response = await router.fetch(new Request('https://api/ws', { method: 'POST' }))
        expect(response.status).toBe(426)
        expect(namespace.calls).toHaveLength(0)
    })
})

// ─── publisher ─────────────────────────────────────────────────────────────────

describe('CloudflareRealtimePublisher', () => {
    test('publish fans out to every shard', async () => {
        const namespace = makeNamespace()
        const publisher = new CloudflareRealtimePublisher(namespace, { shards: () => ['s0', 's1', 's2'] })
        await publisher.publish({ ref: 'tasks', type: 'added', data: { id: 't1' } })
        expect(namespace.calls.map(c => c.id)).toEqual(['name:s0', 'name:s1', 'name:s2'])
        expect(namespace.calls.every(c => c.path === LIVEQUERY_DO_BROADCAST_PATH)).toBe(true)
    })

    test('publish rejects when a shard fails', async () => {
        const publisher = new CloudflareRealtimePublisher(makeNamespace(500), { shards: () => ['s0'] })
        await expect(publisher.publish({ ref: 'tasks', type: 'added', data: { id: 't1' } }))
            .rejects.toThrow('failed on 1 of 1')
    })

    test('register targets the gateway id with the principal', async () => {
        const namespace = makeNamespace()
        const publisher = new CloudflareRealtimePublisher(namespace, { shards: () => [] })
        const ok = await publisher.register(
            { ref: 'tasks', client_id: 'c1', gateway_id: 'do-1', listener_node_id: 'do-1' },
            'alice',
        )
        expect(ok).toBe(true)
        expect(namespace.calls[0]).toMatchObject({
            id: 'id:do-1',
            path: LIVEQUERY_DO_SUBSCRIBE_PATH,
            principal: 'alice',
        })
    })

    test('register with a forged gateway id — false without any call', async () => {
        const namespace = makeNamespace()
        const publisher = new CloudflareRealtimePublisher(namespace, { shards: () => [] })
        const sub = { ref: 'tasks', client_id: 'c1', gateway_id: 'nope', listener_node_id: 'nope' }
        const ok = await publisher.register(sub)
        expect(ok).toBe(false)
        expect(namespace.calls).toHaveLength(0)
    })

    test('register rejected by the gateway — false', async () => {
        const publisher = new CloudflareRealtimePublisher(makeNamespace(403), { shards: () => [] })
        const sub = { ref: 'tasks', client_id: 'c1', gateway_id: 'do-1', listener_node_id: 'do-1' }
        const ok = await publisher.register(sub)
        expect(ok).toBe(false)
    })
})
