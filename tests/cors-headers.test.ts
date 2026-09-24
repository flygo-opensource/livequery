/**
 * A gateway on another origin lists the request headers it accepts in CORS preflight. When the
 * browser client starts sending a header that list lacks, the browser blocks the request before it
 * leaves, fetch fails like a dead network, and an outbox retries forever — nothing on the server
 * ever sees it. `LIVEQUERY_CORS_HEADERS` is the list gateways are told to allow; this test drives
 * every kind of call `RestTransporter` makes and fails if one sends a header outside it.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { LIVEQUERY_CORS_HEADERS } from '../packages/core/build/src/index.js'
import { RestTransporter } from '../packages/rest/src/RestTransporter.js'

const original_fetch = globalThis.fetch
afterEach(() => { globalThis.fetch = original_fetch })

// Safelisted by the Fetch spec, or declared by the application itself.
const ALWAYS_ALLOWED = ['content-type', 'authorization']

describe('LIVEQUERY_CORS_HEADERS', () => {
    test('covers every header RestTransporter sets on its own', async () => {
        const sent = new Set<string>()
        globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            for (const key of Object.keys(init?.headers ?? {})) sent.add(key.toLowerCase())
            const is_list = init?.method === 'GET'
            return new Response(JSON.stringify({ data: is_list ? { items: [] } : { id: 'a' } }))
        }) as typeof fetch

        const transporter = new RestTransporter({ api: 'http://127.0.0.1:1', ws: 'ws://127.0.0.1:1' })
        const socket = (transporter as any).socket
        socket.$gateway.next('gateway-1')
        try {
            await transporter.read({ ref: 'tasks' })
            await transporter.add('tasks', { title: 'a' })
            await transporter.update('tasks', 'a', { title: 'b' }, undefined, { if_version: 1 })
            await transporter.delete('tasks', 'a')
            await transporter.trigger({ ref: 'tasks', action: 'archive', payload: {} } as any)
        } finally {
            socket.stop()
        }

        expect(sent.has('if-match')).toBe(true)
        expect(sent.has('x-lgid')).toBe(true)
        const allowed = new Set([...LIVEQUERY_CORS_HEADERS, ...ALWAYS_ALLOWED])
        expect([...sent].filter(key => !allowed.has(key))).toEqual([])
    })
})
