/**
 * E2E: two independent LivequeryClients (separate sockets, separate client_ids)
 * stay in sync through the realtime pipeline: a mutation made by client A reaches
 * client B without B re-querying.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { LivequeryClient, LivequeryCollection, LivequeryMemoryStorage } from '../client/src/index.js'
import { RestTransporter } from '../rest/src/RestTransporter.js'
import { buildNestMongoApp, type AppHandle } from './helpers/servers.js'
import { uniqueCollection } from './helpers/mongo.js'
import { warmupRealtime } from './helpers/realtime.js'
import { sleep, waitFor } from './helpers/wait.js'
import type { Task } from './helpers/client-suite.js'

const COLLECTION = uniqueCollection('multi_client')

type Stack = {
    transporter: RestTransporter
    client: LivequeryClient
    col: LivequeryCollection<Task>
}

describe('Multi-client realtime sync e2e', () => {
    let app: AppHandle
    let a: Stack
    let b: Stack

    function buildStack(): Stack {
        const transporter = new RestTransporter({ api: app.apiUrl, ws: app.wsUrl })
        const client = new LivequeryClient({
            storage: new LivequeryMemoryStorage(),
            transporters: { rest: transporter },
        })
        const col = new LivequeryCollection<Task>(client, { ssr: false })
        return { transporter, client, col }
    }

    function destroyStack(stack: Stack) {
        stack.col.flush?.()
        stack.client.destroy?.()
        ;(stack.transporter as any).socket?.stop?.()
    }

    const titlesOf = (s: Stack) => s.col.items.value.map(d => d.value.title)

    beforeAll(async () => {
        app = await buildNestMongoApp({ collection: COLLECTION, ref: 'tasks', realtime: true })
        await warmupRealtime(app, 'tasks')
        await app.collection.insertOne({ title: 'shared-seed', done: false, seq: 1 })

        a = buildStack()
        b = buildStack()
        a.col.initialize('tasks')
        b.col.initialize('tasks')
        await waitFor(() => titlesOf(a).includes('shared-seed') && titlesOf(b).includes('shared-seed'), { label: 'both clients loaded' })
    }, 60000)

    afterAll(async () => {
        destroyStack(a)
        destroyStack(b)
        await app?.close()
    }, 30000)

    test('clients have distinct socket identities', () => {
        const cidA = (a.transporter as any).socket?.client_id
        const cidB = (b.transporter as any).socket?.client_id
        expect(cidA).toBeString()
        expect(cidB).toBeString()
        expect(cidA).not.toBe(cidB)
    })

    test('A.add reaches B via realtime without a re-query', async () => {
        const created = await a.col.add({ title: 'from-a', done: false, seq: 2 }) as Task

        await waitFor(() => titlesOf(b).includes('from-a'), { label: 'B receives added' })
        const inB = b.col.items.value.find(d => d.value.title === 'from-a')!.value
        expect(inB.id).toBe(created.id)
    })

    test('A.update reaches B with the changed fields', async () => {
        const doc = a.col.items.value.find(d => d.value.title === 'from-a')!.value
        await a.col.update({ id: doc.id, title: 'from-a-v2', done: true } as any)

        await waitFor(() => titlesOf(b).includes('from-a-v2'), { label: 'B receives modified' })
        const inB = b.col.items.value.find(d => d.value.title === 'from-a-v2')!.value
        expect(inB.done).toBe(true)
    })

    test('A.delete removes the item on B', async () => {
        const doc = a.col.items.value.find(d => d.value.title === 'from-a-v2')!.value
        await a.col.delete(doc.id)
        await waitFor(() => !titlesOf(b).includes('from-a-v2'), { label: 'B receives removed' })
    })

    test('after B unsubscribes, only A keeps receiving', async () => {
        destroyStack(b)
        await sleep(300)
        const bCountBefore = b.col.items.value.length

        await app.collection.insertOne({ title: 'after-b-left', done: false, seq: 9 })
        await waitFor(() => titlesOf(a).includes('after-b-left'), { label: 'A still receives' })

        await sleep(500)
        expect(b.col.items.value.length).toBe(bCountBefore)
        expect(titlesOf(b)).not.toContain('after-b-left')
    })
})
