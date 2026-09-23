/**
 * E2E: two devices, local-first, against Hono + MongoDatasource + realtime + real MongoDB.
 *
 * Device A loses the network (every HTTP request fails with NETWORK_ERROR; its socket stays up, as
 * on a flaky connection where reads trickle in but writes time out) and does a full round of CRUD.
 * Device B stays online and edits the same documents — one different field, one same field. When A
 * is back, both devices and the database must converge:
 *
 * - A's offline add, update and delete reach the server, once each, in order;
 * - different fields merge (A's title + B's done);
 * - the same field is last-writer-wins: A synced last, so A's value everywhere;
 * - no duplicates, no pending flags left.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { LivequeryClient, LivequeryCollection, LivequeryMemoryStorage } from '../packages/client/src/index.js'
import { RestTransporter } from '../packages/rest/src/RestTransporter.js'
import { buildHonoMongoApp, type AppHandle } from './helpers/servers.js'
import { uniqueCollection } from './helpers/mongo.js'
import { warmupRealtime } from './helpers/realtime.js'
import { waitFor } from './helpers/wait.js'
import type { Task } from './helpers/client-suite.js'

type Device = {
    network: { online: boolean }
    transporter: RestTransporter
    client: LivequeryClient
    col: LivequeryCollection<Task>
}

describe('local-first: offline CRUD on one device, concurrent edits on another, convergence', () => {
    let app: AppHandle
    let a: Device
    let b: Device

    const makeDevice = (): Device => {
        const network = { online: true }
        const transporter = new RestTransporter({
            api: app.apiUrl,
            ws: app.wsUrl,
            // Cut the device off: answer every request with a network failure.
            onRequest: () => network.online
                ? undefined
                : { response: { data: undefined, error: { code: 'NETWORK_ERROR', message: 'offline' } } },
        })
        const client = new LivequeryClient({ storage: new LivequeryMemoryStorage(), transporters: { rest: transporter } })
        const col = new LivequeryCollection<Task>(client, { ssr: false, mode: 'local-first' })
        col.initialize('tasks')
        return { network, transporter, client, col }
    }

    const doc = (device: Device, title: string) => device.col.items.value.find(d => d.value.title === title)?.value
    const byId = (device: Device, id: string) => device.col.items.value.find(d => d.value.id === id)?.value
    const serverDocs = async () => (await app.collection.find({}).toArray()).map(d => ({ ...d, id: d._id.toString() }))

    let x: string
    let y: string
    let z_id: string

    beforeAll(async () => {
        app = await buildHonoMongoApp({
            collection: uniqueCollection('local_first_sync'),
            ref: 'tasks',
            realtime: true,
            wrapData: false,
            schema: z.strictObject({ title: z.string(), done: z.boolean(), seq: z.number() }),
        })
        await warmupRealtime(app, 'tasks')
        const { insertedIds } = await app.collection.insertMany([
            { title: 'x', done: false, seq: 1 },
            { title: 'y', done: false, seq: 2 },
            { title: 'z', done: false, seq: 3 },
        ])
        x = insertedIds[0].toString()
        y = insertedIds[1].toString()
        z_id = insertedIds[2].toString()

        a = makeDevice()
        b = makeDevice()
        await waitFor(() => a.col.items.value.length === 3 && b.col.items.value.length === 3, { label: 'both devices loaded' })
    }, 60000)

    afterAll(async () => {
        for (const device of [a, b]) {
            device?.client.destroy()
            ;(device?.transporter as any)?.socket?.stop?.()
        }
        await app?.close()
    }, 30000)

    test('offline, device A still creates, edits and deletes — instantly, marked as waiting', async () => {
        a.network.online = false

        const created = await a.col.add({ title: 'a-new', done: false, seq: 10 })
        await a.col.update({ id: x, title: 'x-by-a' })
        await a.col.update({ id: y, title: 'y-by-a' })
        await a.col.delete(z_id)

        expect(created.id).toStartWith('local:')
        expect(doc(a, 'a-new')?._queued).toBe(true)
        expect(byId(a, x)?.title).toBe('x-by-a')
        expect(byId(a, y)?.title).toBe('y-by-a')
        expect(byId(a, z_id)?._deleting).toBe(true)
        expect((await a.client.outbox.pending()).map(e => e.op)).toEqual(['add', 'update', 'update', 'delete'])

        // Nothing reached the server.
        const titles = (await serverDocs()).map(d => d.title).sort()
        expect(titles).toEqual(['x', 'y', 'z'])
    })

    test('meanwhile device B edits the same documents; A keeps its unsynced fields', async () => {
        await b.col.update({ id: x, done: true })          // a different field than A
        await b.col.update({ id: y, title: 'y-by-b' })     // the same field as A

        await waitFor(async () => {
            const docs = await serverDocs()
            return docs.find(d => d.id === x)?.done === true && docs.find(d => d.id === y)?.title === 'y-by-b'
        }, { label: 'B synced' })

        // B's changes reach A by realtime and are rebased over A's pending edits.
        await waitFor(() => byId(a, x)?.done === true, { label: 'A received B done=true' })
        expect(byId(a, x)?.title).toBe('x-by-a')
        await new Promise(r => setTimeout(r, 300))
        expect(byId(a, y)?.title).toBe('y-by-a')
    })

    test('back online, everything converges — server, device A and device B', async () => {
        a.network.online = true
        a.client.outbox.trigger()

        await waitFor(async () => (await a.client.outbox.pending()).length === 0, { timeout: 15000, label: 'A drained' })

        const server = await serverDocs()
        const expected = {
            x: { title: 'x-by-a', done: true },     // merged: A's title, B's done
            y: { title: 'y-by-a', done: false },    // same field: A wrote last
        }
        expect(server.find(d => d.id === x)).toMatchObject(expected.x)
        expect(server.find(d => d.id === y)).toMatchObject(expected.y)
        expect(server.find(d => d.id === z_id)).toBeUndefined()
        const created = server.filter(d => d.title === 'a-new')
        expect(created).toHaveLength(1)

        for (const [name, device] of [['A', a], ['B', b]] as const) {
            await waitFor(() => byId(device, y)?.title === 'y-by-a'
                && byId(device, x)?.title === 'x-by-a'
                && byId(device, x)?.done === true
                && !byId(device, z_id)
                && device.col.items.value.filter(d => d.value.title === 'a-new').length === 1
                && byId(device, created[0]!.id) !== undefined, { timeout: 10000, label: `device ${name} converged` })
        }

        for (const { value } of a.col.items.value) {
            expect(value.id).not.toStartWith('local:')
            expect(value._queued).toBeUndefined()
            expect(value._adding).toBeUndefined()
            expect(value._prev).toBeUndefined()
            expect(value._deleting).toBeUndefined()
        }
        expect(a.col.items.value.map(d => d.value.title).sort()).toEqual(b.col.items.value.map(d => d.value.title).sort())
    })
})
