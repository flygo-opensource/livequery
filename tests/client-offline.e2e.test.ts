/**
 * E2E: offline-first writes against a real HTTP server that goes away and comes back.
 *
 * LivequeryClient + RestTransporter + an in-process Hono server (strict-schema routes, no Mongo).
 * The server is stopped, so writes fail with a real NETWORK_ERROR; they must stay on screen, sit in
 * the outbox, and reach the server once it is back — including across a "page reload" when the
 * storage is IndexedDB.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { IDBFactory } from 'fake-indexeddb'
import {
    LivequeryClient,
    LivequeryCollection,
    LivequeryIndexedDBStorage,
    LivequeryMemoryStorage,
    type LivequeryStorage,
} from '../packages/client/src/index.js'
import { RestTransporter } from '../packages/rest/src/RestTransporter.js'
import { createMemoryServer, type MemoryTask } from './helpers/memoryServer.js'
import { waitFor } from './helpers/wait.js'

describe('offline-first writes survive a server outage', () => {
    let server: Awaited<ReturnType<typeof createMemoryServer>>
    const clients: LivequeryClient[] = []

    const makeClient = (storage: LivequeryStorage) => {
        const client = new LivequeryClient({
            storage,
            transporters: { rest: new RestTransporter({ api: server.apiUrl }) },
        })
        clients.push(client)
        const col = new LivequeryCollection<MemoryTask>(client, { ssr: false, mode: 'local-first' })
        col.initialize('tasks')
        return { client, col }
    }

    const byTitle = (col: LivequeryCollection<MemoryTask>, title: string) =>
        col.items.value.find(d => d.value.title === title)?.value

    beforeEach(async () => {
        server = await createMemoryServer()
    })

    afterEach(async () => {
        for (const client of clients.splice(0)) client.destroy()
        await server.close()
    })

    test('add, update and delete made while the server is down are replayed in order', async () => {
        const { client, col } = makeClient(new LivequeryMemoryStorage())
        const kept = await col.add({ title: 'kept', done: false })
        const doomed = await col.add({ title: 'doomed', done: false })
        expect(server.tasks.size).toBe(2)

        await server.stop()

        const created = await col.add({ title: 'offline', done: false })
        expect(created._queued).toBe(true)
        await col.update({ id: kept.id, done: true })
        await col.delete(doomed.id)

        // Optimistic UI: everything already shows, marked as waiting.
        expect(byTitle(col, 'offline')?._queued).toBe(true)
        expect(byTitle(col, 'kept')?.done).toBe(true)
        expect(byTitle(col, 'doomed')?._deleting).toBe(true)
        expect((await client.outbox.pending()).map(e => e.op)).toEqual(['add', 'update', 'delete'])

        const before = server.writes().length
        server.start()
        client.outbox.trigger()

        await waitFor(async () => (await client.outbox.pending()).length === 0, { label: 'outbox drained' })
        const replayed = server.writes().slice(before)
        expect(replayed.map(r => r.method)).toEqual(['POST', 'PATCH', 'DELETE'])
        expect(replayed.map(r => r.body ?? null)).toEqual([{ title: 'offline', done: false, id: created.id }, { done: true }, null])

        // The server kept the id chosen offline: nothing to rename.
        const offline = [...server.tasks.values()].find(t => t.title === 'offline')!
        expect(offline.id).toBe(created.id)
        expect(server.tasks.get(kept.id)?.done).toBe(true)
        expect(server.tasks.has(doomed.id)).toBe(false)
        await waitFor(() => byTitle(col, 'offline')?.id === offline.id, { label: 'collection holds the document under its id' })

        for (const { value } of col.items.value) {
            expect(value._queued).toBeUndefined()
            expect(value._adding).toBeUndefined()
            expect(value._prev).toBeUndefined()
        }
        expect(byTitle(col, 'doomed')).toBeUndefined()
    })

    test('the backoff timer retries on its own once the server is back', async () => {
        const { client, col } = makeClient(new LivequeryMemoryStorage())
        await server.stop()
        await col.add({ title: 'eventually', done: false })
        server.start()

        // No trigger: the first retry is scheduled ~2s after the failure.
        await waitFor(() => [...server.tasks.values()].some(t => t.title === 'eventually'), { timeout: 6000, label: 'retried by backoff' })
        await waitFor(async () => (await client.outbox.pending()).length === 0, { label: 'outbox drained' })
    })

    test('with IndexedDB, writes queued before a reload are sent by the next page', async () => {
        const indexedDB = new IDBFactory()
        await server.stop()

        const before_reload = makeClient(new LivequeryIndexedDBStorage({ indexedDB, name: 'app' }))
        const draft = await before_reload.col.add({ title: 'from-last-session', done: false })
        expect(draft._queued).toBe(true)
        before_reload.client.destroy()

        server.start()
        const after_reload = makeClient(new LivequeryIndexedDBStorage({ indexedDB, name: 'app' }))

        await waitFor(() => [...server.tasks.values()].some(t => t.title === 'from-last-session'), { label: 'replayed after reload' })
        const created = [...server.tasks.values()].find(t => t.title === 'from-last-session')!
        await waitFor(() => byTitle(after_reload.col, 'from-last-session')?.id === created.id, { label: 'collection shows the server id' })
        expect(await after_reload.client.outbox.pending()).toEqual([])
    })

    test('a validation error is not retried', async () => {
        const { client, col } = makeClient(new LivequeryMemoryStorage())
        await col.add({ title: 'bad', done: 'nope' } as any)

        const doc = byTitle(col, 'bad')!
        expect(doc._adding_error?.code).toBe('VALIDATION_FAILED')
        expect(await client.outbox.pending()).toEqual([])
    })
})
