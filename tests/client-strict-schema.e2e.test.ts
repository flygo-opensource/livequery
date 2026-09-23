/**
 * E2E: LivequeryClient + RestTransporter writing through a route guarded by `validator()` with a
 * `z.strictObject` schema.
 *
 * - Before 3.0 the client sent `id: "local:..."` in every write body and a strict schema answered
 *   400 VALIDATION_FAILED.
 * - Since 3.0 an add carries the uuidv7 the client chose. The schema never sees it (`id` belongs to
 *   the protocol, not the app's schema); the server keeps it, so a retried add cannot duplicate.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { LivequeryClient, LivequeryCollection, LivequeryMemoryStorage } from '../packages/client/src/index.js'
import { RestTransporter } from '../packages/rest/src/RestTransporter.js'
import { createMemoryServer, type MemoryTask } from './helpers/memoryServer.js'
import { waitFor } from './helpers/wait.js'

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('writes through a strict-schema route', () => {
    let server: Awaited<ReturnType<typeof createMemoryServer>>
    let client: LivequeryClient

    beforeAll(async () => {
        server = await createMemoryServer()
        client = new LivequeryClient({
            storage: new LivequeryMemoryStorage(),
            transporters: { rest: new RestTransporter({ api: server.apiUrl }) },
        })
    })

    afterAll(async () => {
        client.destroy()
        await server.close()
    })

    const post = (body: unknown) => fetch(`${server.apiUrl}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })

    test('server-first add keeps the client id; update sends only the edited fields', async () => {
        const col = new LivequeryCollection<MemoryTask>(client, { ssr: false, mode: 'server-first' })
        col.initialize('tasks')

        const created = await col.add({ title: 'strict', done: false })
        expect(created.id).toMatch(UUID_V7)
        expect(server.tasks.get(created.id)?.title).toBe('strict')
        const add = server.writes().find(r => r.method === 'POST')
        expect(add?.body).toEqual({ title: 'strict', done: false, id: created.id })

        await col.update({ id: created.id, title: 'strict-2' })
        expect(server.tasks.get(created.id)?.title).toBe('strict-2')
        const patch = server.writes().find(r => r.method === 'PATCH')
        expect(patch?.body).toEqual({ title: 'strict-2' })
    })

    test('local-first add then update reach the server with clean bodies', async () => {
        const col = new LivequeryCollection<MemoryTask>(client, { ssr: false, mode: 'local-first' })
        col.initialize('tasks')

        const created = await col.add({ title: 'local', done: false })
        expect(created.id).toMatch(UUID_V7)
        await waitFor(() => col.items.value.some(d => d.value.id === created.id && !d.value._adding))

        await col.update({ id: created.id, done: true })
        expect(server.tasks.get(created.id)?.done).toBe(true)
        const item = col.items.value.find(d => d.value.id === created.id)?.value
        expect(item?._prev).toBeUndefined()
        expect(item?._updating_error).toBeUndefined()
        for (const write of server.writes()) {
            if (write.method === 'PATCH') expect(write.body ?? {}).not.toHaveProperty('id')
        }
    })

    test('the server validates the id: legacy local: is ignored, anything but a uuidv7 is 400', async () => {
        const legacy = await post({ id: 'local:01890a5d-ac96-774b-bcce-b302099a8057', title: 'old client', done: false })
        expect(legacy.status).toBe(200)
        expect((await legacy.json()).data.id).toStartWith('srv-')

        const objectid = await post({ id: '66f1c2d3e4f5a6b7c8d9e0f1', title: 'x', done: false })
        expect(objectid.status).toBe(400)
        expect((await objectid.json()).error.code).toBe('INVALID_ID')
    })

    test('an add retried after a lost response creates exactly one document', async () => {
        const col = new LivequeryCollection<MemoryTask>(client, { ssr: false, mode: 'local-first' })
        col.initialize('tasks')
        const before = server.tasks.size
        server.loseNextResponse()

        const result = await col.add({ title: 'exactly-once', done: false })
        expect(result._queued).toBe(true)
        expect(server.tasks.size).toBe(before + 1)

        client.outbox.trigger()
        await waitFor(async () => (await client.outbox.pending()).length === 0, { label: 'retry drained' })
        expect([...server.tasks.values()].filter(t => t.title === 'exactly-once')).toHaveLength(1)
        const statuses = server.writes().slice(-3).map(r => r.method)
        expect(statuses).toEqual(['POST', 'POST', 'PATCH'])
        const doc = col.items.value.find(d => d.value.id === result.id)?.value
        expect(doc?._adding).toBeUndefined()
        expect(doc?._adding_error).toBeUndefined()
    })
})
