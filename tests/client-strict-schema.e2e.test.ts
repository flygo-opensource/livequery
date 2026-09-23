/**
 * E2E: LivequeryClient + RestTransporter writing through a route guarded by `validator()` with a
 * `z.strictObject` schema. Before the fix the client sent `id: "local:..."` in every write body and
 * a strict schema answered 400 VALIDATION_FAILED.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { LivequeryClient, LivequeryCollection, LivequeryMemoryStorage } from '../packages/client/src/index.js'
import { RestTransporter } from '../packages/rest/src/RestTransporter.js'
import { createMemoryServer, type MemoryTask } from './helpers/memoryServer.js'
import { waitFor } from './helpers/wait.js'

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

    test('server-first add and update succeed and never send an id in the body', async () => {
        const col = new LivequeryCollection<MemoryTask>(client, { ssr: false, mode: 'server-first' })
        col.initialize('tasks')

        const created = await col.add({ title: 'strict', done: false })
        expect(created.id).toStartWith('srv-')
        expect(server.tasks.get(created.id)?.title).toBe('strict')

        await col.update({ id: created.id, title: 'strict-2' })
        expect(server.tasks.get(created.id)?.title).toBe('strict-2')

        const patch = server.writes().find(r => r.method === 'PATCH')
        expect(patch?.body).toEqual({ title: 'strict-2' })
        for (const write of server.writes()) expect(write.body ?? {}).not.toHaveProperty('id')
    })

    test('local-first add then update reach the server with clean bodies', async () => {
        const col = new LivequeryCollection<MemoryTask>(client, { ssr: false, mode: 'local-first' })
        col.initialize('tasks')

        const created = await col.add({ title: 'local', done: false })
        expect(created.id).toStartWith('srv-')
        await waitFor(() => col.items.value.some(d => d.value.id === created.id && !d.value._adding))

        await col.update({ id: created.id, done: true })
        expect(server.tasks.get(created.id)?.done).toBe(true)
        const item = col.items.value.find(d => d.value.id === created.id)?.value
        expect(item?._prev).toBeUndefined()
        expect(item?._updating_error).toBeUndefined()
        for (const write of server.writes()) expect(write.body ?? {}).not.toHaveProperty('id')
    })
})
