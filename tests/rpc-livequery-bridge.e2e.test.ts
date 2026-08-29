/**
 * E2E: livequery state shipped across an RPC worker boundary.
 *
 * Simulates the SharedWorker architecture: the LivequeryCollection lives on the
 * "worker" side (real backend: NestJS + MongoDatasource + MongodbRealtime + Mongo);
 * the "UI" side talks to it only through @livequery/rpc (WorkerManager ↔
 * ServiceLinker over an in-memory channel pair). Realtime mongo changes must
 * stream through RPC into the UI-side observable.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { LivequeryClient, LivequeryCollection, LivequeryMemoryStorage } from '../client/src/index.js'
import { RestTransporter } from '../rest/src/RestTransporter.js'
import { RpcChannel, type RpcMessage } from '../rpc/src/RpcChannel.js'
import { ServiceLinker } from '../rpc/src/ServiceLinker.js'
import { WorkerManager } from '../rpc/src/WorkerManager.js'
import { buildNestMongoApp, type AppHandle } from './helpers/servers.js'
import { uniqueCollection } from './helpers/mongo.js'
import { warmupRealtime } from './helpers/realtime.js'
import { waitFor } from './helpers/wait.js'
import type { Task } from './helpers/client-suite.js'

const COLLECTION = uniqueCollection('rpc_bridge')

class MemoryChannel extends RpcChannel {
    peer?: MemoryChannel
    send(message: RpcMessage): void {
        this.peer?.next({
            ...message,
            respond: response => {
                this.next({ id: message.id, response, respond: () => undefined })
            },
        })
    }
}

describe('RPC bridge: livequery collection across a worker boundary e2e', () => {
    let app: AppHandle
    let transporter: RestTransporter
    let client: LivequeryClient
    let col: LivequeryCollection<Task>
    let linker: ServiceLinker
    let todos: any

    beforeAll(async () => {
        app = await buildNestMongoApp({ collection: COLLECTION, ref: 'tasks', realtime: true })
        await warmupRealtime(app, 'tasks')
        await app.collection.insertOne({ title: 'rpc-seed', done: false, seq: 1 })

        // ── worker side ──────────────────────────────────────────────────────
        transporter = new RestTransporter({ api: app.apiUrl, ws: app.wsUrl })
        client = new LivequeryClient({
            storage: new LivequeryMemoryStorage(),
            transporters: { rest: transporter },
        })
        // ssr: false — worker scopes have no `window`; this is the exact use-case the
        // explicit option exists for (SharedWorker-hosted collections).
        col = new LivequeryCollection<Task>(client, { ssr: false })
        col.initialize('tasks')
        await waitFor(() => col.items.value.length >= 1, { label: 'worker-side collection load' })

        const uiChannel = new MemoryChannel()
        const workerChannel = new MemoryChannel()
        uiChannel.peer = workerChannel
        workerChannel.peer = uiChannel

        new WorkerManager(workerChannel).exposeService('todos', {
            items$: col.items,
            add: (payload: Partial<Task>) => col.add(payload as any),
            delete: (id: string) => col.delete(id),
        })

        // ── UI side ──────────────────────────────────────────────────────────
        linker = new ServiceLinker(uiChannel)
        todos = linker.linkService<any>('todos')
    }, 60000)

    afterAll(async () => {
        col?.flush?.()
        client?.destroy?.()
        ;(transporter as any)?.socket?.stop?.()
        await app?.close()
    }, 30000)

    test('UI side receives collection items through the RPC observable', async () => {
        const snapshots: any[][] = []
        const sub = todos.items$.subscribe((items: any[]) => snapshots.push(items))
        try {
            await waitFor(() => snapshots.length >= 1, { label: 'first RPC emission' })
            const titles = snapshots.at(-1)!.map((d: any) => d.value?.title ?? d.title)
            expect(titles).toContain('rpc-seed')
        } finally {
            sub.unsubscribe()
        }
    })

    test('out-of-band mongo insert streams through RPC into the UI', async () => {
        const snapshots: any[][] = []
        const sub = todos.items$.subscribe((items: any[]) => snapshots.push(items))
        try {
            await waitFor(() => snapshots.length >= 1, { label: 'baseline emission' })
            await app.collection.insertOne({ title: 'rpc-live-insert', done: false, seq: 2 })

            await waitFor(() => {
                const latest = snapshots.at(-1) ?? []
                return latest.some((d: any) => (d.value?.title ?? d.title) === 'rpc-live-insert')
            }, { label: 'realtime item over RPC' })
        } finally {
            sub.unsubscribe()
        }
    })

    test('UI-side method call mutates through the worker collection into mongo', async () => {
        const created = await todos.add({ title: 'rpc-add', done: false, seq: 3 })
        expect(created.id).toBeString()

        const stored = await waitFor(() => app.collection.findOne({ title: 'rpc-add' }), { label: 'mongo persisted via RPC' })
        expect(stored!._id.toString()).toBe(created.id)

        await todos.delete(created.id)
        await waitFor(async () => (await app.collection.findOne({ title: 'rpc-add' })) == null, { label: 'mongo deleted via RPC' })
    })
})
