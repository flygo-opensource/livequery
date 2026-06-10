/**
 * Shared fullstack suite: LivequeryClient + RestTransporter + MemoryStorage against a
 * real backend (NestJS or Hono) + MongoDatasource + MongodbRealtime + real MongoDB.
 * Both adapter test files run this exact same matrix, proving the client is
 * adapter-agnostic.
 */

// LivequeryCollection.initialize() guards on `window` — expose it for bun tests
;(globalThis as any).window ??= {}

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { LivequeryClient, LivequeryCollection, LivequeryMemoryStorage } from '../../client/src/index.js'
import { RestTransporter } from '../../rest/src/RestTransporter.js'
import type { AppHandle } from './servers.js'
import { warmupRealtime } from './realtime.js'
import { sleep, waitFor } from './wait.js'

export type Task = {
    id: string
    title: string
    done: boolean
    seq: number
}

export function defineClientFullstackSuite(
    label: string,
    build: () => Promise<AppHandle>,
) {
    describe(`LivequeryClient → ${label} → MongoDatasource fullstack e2e`, () => {
        let app: AppHandle
        let transporter: RestTransporter
        let client: LivequeryClient
        let col: LivequeryCollection<Task>

        const titles = () => col.items.value.map(d => d.value.title)

        beforeAll(async () => {
            app = await build()
            await warmupRealtime(app, 'tasks')

            await app.collection.insertMany([
                { title: 'seed-1', done: false, seq: 1 },
                { title: 'seed-2', done: false, seq: 2 },
                { title: 'seed-3', done: true, seq: 3 },
            ])

            transporter = new RestTransporter({ api: app.apiUrl, ws: app.wsUrl })
            client = new LivequeryClient({
                storage: new LivequeryMemoryStorage(),
                transporters: { rest: transporter },
            })

            col = new LivequeryCollection<Task>(client, { filters: { 'seq:sort': 'asc' } })
            col.initialize('tasks')
            await waitFor(() => col.items.value.length >= 3, { label: 'initial collection load' })
        }, 60000)

        afterAll(async () => {
            col?.flush?.()
            client?.destroy?.()
            ;(transporter as any)?.socket?.stop?.()
            await app?.close()
        }, 30000)

        test('initial query populates collection items from the server', () => {
            expect(titles()).toEqual(expect.arrayContaining(['seed-1', 'seed-2', 'seed-3']))
            const seed1 = col.items.value.find(d => d.value.title === 'seed-1')!.value
            expect(seed1.id).toBeString()
            expect(col.loading.value).toBeNull()
            expect(col.error.value).toBeNull()
        })

        test('out-of-band mongo update flows into collection items (realtime modified)', async () => {
            await app.collection.updateOne({ title: 'seed-1' }, { $set: { title: 'seed-1-live', done: true } })

            await waitFor(() => titles().includes('seed-1-live'), { label: 'realtime modified' })
            const doc = col.items.value.find(d => d.value.title === 'seed-1-live')!.value
            expect(doc.done).toBe(true)
            expect(titles()).not.toContain('seed-1')
        })

        test('out-of-band mongo insert appears in collection (realtime added)', async () => {
            await app.collection.insertOne({ title: 'live-insert', done: false, seq: 4 })
            await waitFor(() => titles().includes('live-insert'), { label: 'realtime added' })
        })

        test('out-of-band mongo delete removes the item (realtime removed)', async () => {
            const target = await waitFor(() => col.items.value.find(d => d.value.title === 'seed-2'), { label: 'seed-2 present' })
            await app.collection.deleteOne({ title: 'seed-2' })
            await waitFor(() => !titles().includes('seed-2'), { label: 'realtime removed' })
            expect(col.items.value.find(d => d.value.id === target.value.id)).toBeUndefined()
        })

        test('collection.add persists to mongo (server-first) without duplicating via realtime echo', async () => {
            const created = await col.add({ title: 'client-add', done: false, seq: 5 }) as Task
            expect(created.id).toBeString()

            const stored = await waitFor(() => app.collection.findOne({ title: 'client-add' }), { label: 'mongo persisted' })
            expect(stored!._id.toString()).toBe(created.id)

            // realtime echo of our own insert must not duplicate the item
            await sleep(800)
            const copies = col.items.value.filter(d => d.value.title === 'client-add')
            expect(copies.length).toBe(1)
            expect(copies[0].value._adding).toBeFalsy()
        })

        test('collection.update persists field changes to mongo', async () => {
            const doc = col.items.value.find(d => d.value.title === 'client-add')!.value
            await col.update({ id: doc.id, title: 'client-add-updated' } as any)

            await waitFor(async () => {
                const stored = await app.collection.findOne({ title: 'client-add-updated' })
                return stored != null
            }, { label: 'mongo updated' })

            await waitFor(() => titles().includes('client-add-updated'), { label: 'collection state updated' })
        })

        test('collection.delete removes from mongo and from collection state', async () => {
            const doc = col.items.value.find(d => d.value.title === 'client-add-updated')!.value
            await col.delete(doc.id)

            await waitFor(async () => {
                const stored = await app.collection.findOne({ title: 'client-add-updated' })
                return stored == null
            }, { label: 'mongo deleted' })
            await waitFor(() => !titles().includes('client-add-updated'), { label: 'collection state removed' })
        })

        test('server-side filters via collection query', async () => {
            const filtered = new LivequeryCollection<Task>(client, {
                filters: { 'done:eq-boolean': true } as any,
            })
            filtered.initialize('tasks')
            try {
                await waitFor(() => filtered.items.value.length >= 1 && filtered.loading.value === null, { label: 'filtered load' })
                expect(filtered.items.value.every(d => d.value.done === true)).toBe(true)
            } finally {
                filtered.flush()
            }
        })

        test('cursor pagination with loadMore against real MongoQuery cursors', async () => {
            const bulk = Array.from({ length: 22 }, (_, i) => ({ title: `bulk-${i}`, done: false, seq: 100 + i }))
            await app.collection.insertMany(bulk)
            // wait until the realtime stream has flushed all bulk inserts into the main
            // collection, so the paged collection below only receives its own query pages
            await waitFor(() => titles().includes('bulk-21'), { label: 'bulk realtime flushed' })
            await sleep(500)

            const paged = new LivequeryCollection<Task>(client, {
                filters: { ':limit': 10, 'seq:sort': 'asc' } as any,
            })
            paged.initialize('tasks')
            try {
                await waitFor(() => paged.items.value.length >= 10 && paged.loading.value === null, { label: 'first page' })
                const firstPageCount = paged.items.value.length
                expect(firstPageCount).toBe(10)
                expect(paged.paging.value.next).toBeDefined()

                paged.loadMore()
                await waitFor(() => paged.items.value.length >= 20 && paged.loading.value === null, { label: 'second page' })

                const ids = paged.items.value.map(d => d.value.id)
                expect(new Set(ids).size).toBe(ids.length) // no overlap between pages

                const seqs = paged.items.value.map(d => d.value.seq)
                expect([...seqs].sort((a, b) => a - b)).toEqual(seqs) // server sort preserved
            } finally {
                paged.flush()
            }
        })
    })
}
