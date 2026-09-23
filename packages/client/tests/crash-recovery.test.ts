/**
 * A crash between writing a local-first document and queueing its write must not leave a
 * document marked pending that is never sent. Each "crash" is a storage write that never
 * completes; a new client on the same data plays the restart.
 */
import { describe, expect, test } from 'bun:test'
import { BehaviorSubject, Observable } from 'rxjs'
import { LivequeryClient, LIVEQUERY_INTENT_REF } from '../src/LivequeryClient.js'
import { LIVEQUERY_OUTBOX_REF } from '../src/LivequeryOutbox.js'
import { LivequeryMemoryStorage } from '../src/LivequeryMemoryStorage.js'
import type { LivequeryQueryResult, LivequeryStorage, LivequeryTransporter } from '../src/index.js'

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

async function waitUntil(check: () => boolean | Promise<boolean>, ms = 3000) {
    const started = Date.now()
    while (!(await check())) {
        if (Date.now() - started > ms) throw new Error('timed out')
        await tick(10)
    }
}

function makeServer() {
    const calls: Array<{ op: string, id: string }> = []
    const transporter: LivequeryTransporter = {
        query: () => new Observable<Partial<LivequeryQueryResult>>(s => { s.next({ changes: [], paging: { total: 0, current: 0 }, source: 'query' }) }),
        add: async (_ref, doc: any) => { calls.push({ op: 'add', id: doc.id }); return doc },
        update: async (_ref, id, doc: any) => { calls.push({ op: 'update', id }); return { item: { id, ...doc } } as any },
        delete: async (_ref, id) => { calls.push({ op: 'delete', id }); return { id } as any },
        trigger: async () => ({}) as any,
        status$: new BehaviorSubject({ connected: true }),
    }
    return { transporter, calls }
}

// The crash: from the moment `when` matches, that write and every write after it never finish.
function crashing(storage: LivequeryStorage, when: (op: string, collection: string) => boolean): LivequeryStorage {
    let crashed = false
    const hang = () => new Promise<never>(() => undefined)
    const guard = <A extends any[], R>(op: string, fn: (collection: string, ...args: A) => Promise<R>) =>
        (collection: string, ...args: A): Promise<R> => {
            if (crashed || when(op, collection)) {
                crashed = true
                return hang()
            }
            return fn.call(storage, collection, ...args)
        }
    return {
        query: storage.query.bind(storage),
        get: storage.get.bind(storage),
        add: guard('add', storage.add),
        update: guard('update', storage.update),
        delete: guard('delete', storage.delete),
        flush: storage.flush.bind(storage),
    } as LivequeryStorage
}

const client = (storage: LivequeryStorage, transporter: LivequeryTransporter) =>
    new LivequeryClient({ storage, transporters: { t: transporter } })

describe('a crash between a local-first write and its outbox entry', () => {
    test('add: the document is sent after the restart', async () => {
        const storage = new LivequeryMemoryStorage()
        const server = makeServer()
        const before = client(crashing(storage, (op, c) => op === 'add' && c === LIVEQUERY_OUTBOX_REF), server.transporter)
        before.add('todos', [{ id: 'a1', title: 'written just before the crash' } as any], 'local-first')
        await waitUntil(async () => !!(await storage.get<any>('todos', 'a1'))?._adding)
        before.destroy()
        expect(server.calls).toEqual([])

        const after = client(storage, server.transporter)
        await waitUntil(() => server.calls.some(c => c.op === 'add' && c.id === 'a1'))
        await waitUntil(async () => (await storage.query(LIVEQUERY_INTENT_REF)).documents.length === 0)
        after.destroy()
    })

    test('update and delete: sent after the restart', async () => {
        const storage = new LivequeryMemoryStorage()
        await storage.add('todos', { id: 'u1', title: 'on the server' } as any)
        await storage.add('todos', { id: 'd1', title: 'on the server' } as any)
        const server = makeServer()
        const before = client(crashing(storage, (op, c) => op === 'add' && c === LIVEQUERY_OUTBOX_REF), server.transporter)
        before.update('todos', [{ id: 'u1', title: 'edited' } as any], 'local-first')
        await waitUntil(async () => !!(await storage.get<any>('todos', 'u1'))?._prev)
        before.destroy()

        const again = client(crashing(storage, (op, c) => op === 'add' && c === LIVEQUERY_OUTBOX_REF), server.transporter)
        again.delete('todos', ['d1'], 'local-first')
        await waitUntil(async () => !!(await storage.get<any>('todos', 'd1'))?._deleting)
        again.destroy()
        expect(server.calls).toEqual([])

        const after = client(storage, server.transporter)
        await waitUntil(() => server.calls.some(c => c.op === 'update' && c.id === 'u1') && server.calls.some(c => c.op === 'delete' && c.id === 'd1'))
        after.destroy()
    })

    test('crash after the entry was queued: sent once, not twice', async () => {
        const storage = new LivequeryMemoryStorage()
        const server = makeServer()
        // The entry is written; clearing the intent never completes — nor does anything after.
        const before = client(crashing(storage, (op, c) => op === 'delete' && c === LIVEQUERY_INTENT_REF), server.transporter)
        // No network yet, so the entry stays queued.
        ;(server.transporter.status$ as BehaviorSubject<{ connected: boolean }>).next({ connected: false })
        const offline = { ...server.transporter, add: async () => { throw { code: 'NETWORK_ERROR', message: 'offline' } } }
        const queued = client(crashing(storage, (op, c) => op === 'delete' && c === LIVEQUERY_INTENT_REF), offline as LivequeryTransporter)
        before.destroy()
        queued.add('todos', [{ id: 'q1', title: 'queued' } as any], 'local-first')
        await waitUntil(async () => (await storage.query(LIVEQUERY_OUTBOX_REF)).documents.length === 1)
        await tick(50)
        queued.destroy()
        expect((await storage.query(LIVEQUERY_INTENT_REF)).documents).toHaveLength(1)

        ;(server.transporter.status$ as BehaviorSubject<{ connected: boolean }>).next({ connected: true })
        const after = client(storage, server.transporter)
        await waitUntil(() => server.calls.some(c => c.id === 'q1'))
        await tick(200)
        expect(server.calls.filter(c => c.id === 'q1')).toEqual([{ op: 'add', id: 'q1' }])
        after.destroy()
    })

    test('crash before the document was written: nothing to send, the intent is dropped', async () => {
        const storage = new LivequeryMemoryStorage()
        const server = makeServer()
        const before = client(crashing(storage, (op, c) => op === 'add' && c === 'todos'), server.transporter)
        before.add('todos', [{ id: 'n1', title: 'never written' } as any], 'local-first')
        await waitUntil(async () => (await storage.query(LIVEQUERY_INTENT_REF)).documents.length === 1)
        before.destroy()

        const after = client(storage, server.transporter)
        await waitUntil(async () => (await storage.query(LIVEQUERY_INTENT_REF)).documents.length === 0)
        await tick(100)
        expect(server.calls).toEqual([])
        after.destroy()
    })
})
