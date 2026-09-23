import { describe, expect, test } from 'bun:test'
import { ReplaySubject } from 'rxjs'
import { LivequeryClient, type ConflictResolverFunction } from '../src/LivequeryClient.js'
import { LivequeryCollection } from '../src/LivequeryCollection.js'
import { LivequeryMemoryStorage } from '../src/LivequeryMemoryStorage.js'
import type { DataChangeEvent, Doc, LivequeryQueryResult, LivequeryTransporter } from '../src/index.js'

type Todo = Doc<{ title: string, done: boolean, note?: string }>

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

async function waitUntil(check: () => boolean | Promise<boolean>, ms = 2000) {
    const started = Date.now()
    while (!(await check())) {
        if (Date.now() - started > ms) throw new Error('timed out')
        await tick(10)
    }
}

function makeSetup(options: { conflictResolver?: ConflictResolverFunction } = {}) {
    const stream = new ReplaySubject<Partial<LivequeryQueryResult>>(100)
    const state = { online: true }
    const updates: Array<{ id: string, body: Record<string, any> }> = []
    const deletes: string[] = []
    const guard = () => {
        if (!state.online) throw { code: 'NETWORK_ERROR', message: 'offline' }
    }
    const transporter: LivequeryTransporter = {
        query: () => stream,
        add: async (_ref, body) => {
            guard()
            return { ...body, id: 'srv-new' } as any
        },
        update: async (_ref, id, body) => {
            guard()
            updates.push({ id, body })
            return { id, ...body } as any
        },
        delete: async (_ref, id) => {
            guard()
            deletes.push(id)
            return { id } as any
        },
        trigger: async () => ({}) as any,
    }
    const storage = new LivequeryMemoryStorage()
    const client = new LivequeryClient({ storage, transporters: { rest: transporter }, ...options })
    const col = new LivequeryCollection<Todo>(client, { ssr: false, mode: 'local-first' })
    col.initialize('todos')
    stream.next({
        changes: [{ collection_ref: 'todos', id: '1', type: 'added', data: { id: '1', title: 'server', done: false, note: 'n0' } }],
        source: 'query',
    })
    const realtime = (change: Omit<DataChangeEvent, 'collection_ref'>) => stream.next({
        changes: [{ collection_ref: 'todos', ...change }],
        source: 'realtime',
    })
    const doc = () => col.items.value.find(d => d.value.id === '1')?.value
    return { client, col, storage, state, updates, deletes, realtime, doc }
}

describe('conflict rebase — local field wins until its push is confirmed', () => {
    test('a remote edit of the same field keeps the local value, other fields take the remote value', async () => {
        const { client, storage, state, realtime, doc, col } = makeSetup()
        await waitUntil(() => doc()?.title === 'server')
        state.online = false
        await col.update({ id: '1', title: 'mine' })

        realtime({ id: '1', type: 'modified', data: { title: 'theirs', done: true } })
        await waitUntil(() => doc()?.done === true)

        expect(doc()?.title).toBe('mine')
        // The stored copy is rebased too, not just what the collection shows.
        expect(await storage.get('todos', '1')).toMatchObject({ title: 'mine', done: true, _prev: { title: 'server' } })
        client.destroy()
    })

    test('a full re-read (added) is rebased the same way', async () => {
        const { client, storage, state, realtime, doc, col } = makeSetup()
        await waitUntil(() => doc()?.title === 'server')
        state.online = false
        await col.update({ id: '1', note: 'mine' })

        realtime({ id: '1', type: 'added', data: { id: '1', title: 'renamed', done: false, note: 'theirs' } })
        await tick(50)
        expect(await storage.get('todos', '1')).toMatchObject({ title: 'renamed', note: 'mine', _prev: { note: 'n0' } })
        client.destroy()
    })

    test('once the push is confirmed the remote wins again', async () => {
        const { client, state, realtime, doc, col, updates } = makeSetup()
        await waitUntil(() => doc()?.title === 'server')
        state.online = false
        await col.update({ id: '1', title: 'mine' })
        realtime({ id: '1', type: 'modified', data: { title: 'theirs' } })
        await tick()
        expect(doc()?.title).toBe('mine')

        state.online = true
        client.outbox.trigger()
        await waitUntil(() => updates.length === 1 && doc()?._prev === undefined)
        expect(updates[0]).toEqual({ id: '1', body: { title: 'mine' } })

        realtime({ id: '1', type: 'modified', data: { title: 'later' } })
        await waitUntil(() => doc()?.title === 'later')
        client.destroy()
    })

    test('a pending delete swallows remote edits', async () => {
        const { client, storage, state, realtime, doc, col } = makeSetup()
        await waitUntil(() => doc()?.title === 'server')
        state.online = false
        await col.delete('1')
        expect(doc()?._deleting).toBe(true)

        realtime({ id: '1', type: 'modified', data: { title: 'theirs' } })
        await tick(50)
        expect(doc()?.title).toBe('server')
        expect(await storage.get('todos', '1')).toMatchObject({ title: 'server', _deleting: true })
        client.destroy()
    })

    test('a remote delete wins over a pending edit', async () => {
        const { client, storage, state, realtime, doc, col, updates } = makeSetup()
        await waitUntil(() => doc()?.title === 'server')
        state.online = false
        await col.update({ id: '1', title: 'mine' })

        realtime({ id: '1', type: 'removed' })
        await waitUntil(() => doc() === undefined)
        expect(await storage.get('todos', '1')).toBeNull()

        state.online = true
        client.outbox.trigger()
        await waitUntil(async () => (await client.outbox.pending()).length === 0)
        expect(updates).toEqual([])
        client.destroy()
    })

    test('a custom resolver decides — rejecting drops the change', async () => {
        const seen: any[] = []
        const conflictResolver: ConflictResolverFunction = ({ old_document, change, from }) => {
            seen.push({ old_document, change, from })
            return { approved: false, document: old_document }
        }
        const { client, storage, state, realtime, doc, col } = makeSetup({ conflictResolver })
        await waitUntil(() => doc()?.title === 'server')
        state.online = false
        await col.update({ id: '1', title: 'mine' })

        realtime({ id: '1', type: 'modified', data: { done: true } })
        await tick(50)
        expect(doc()?.done).toBe(false)
        expect(await storage.get('todos', '1')).toMatchObject({ done: false })
        expect(seen[0].from).toEqual({ transporter_id: 'rest' })
        expect(seen[0].old_document).toMatchObject({ title: 'mine', _prev: { title: 'server' } })
        client.destroy()
    })

    test('a custom resolver decides — approving writes its document', async () => {
        const conflictResolver: ConflictResolverFunction = ({ old_document, change }) => ({
            approved: true,
            document: { ...old_document, ...change.data, title: `${old_document['title' as keyof typeof old_document]}+${change.data?.title}` },
        })
        const { client, storage, state, realtime, doc, col } = makeSetup({ conflictResolver })
        await waitUntil(() => doc()?.title === 'server')
        state.online = false
        await col.update({ id: '1', title: 'mine' })

        realtime({ id: '1', type: 'modified', data: { title: 'theirs' } })
        await waitUntil(() => doc()?.title === 'mine+theirs')
        expect(await storage.get('todos', '1')).toMatchObject({ title: 'mine+theirs' })
        client.destroy()
    })

    test('documents without local edits are not touched by the resolver', async () => {
        let calls = 0
        const { client, realtime, doc } = makeSetup({ conflictResolver: ({ old_document }) => (calls++, { approved: false, document: old_document }) })
        await waitUntil(() => doc()?.title === 'server')
        realtime({ id: '1', type: 'modified', data: { title: 'theirs' } })
        await waitUntil(() => doc()?.title === 'theirs')
        expect(calls).toBe(0)
        client.destroy()
    })
})
