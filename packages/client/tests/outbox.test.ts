import { describe, expect, test } from 'bun:test'
import { BehaviorSubject, NEVER } from 'rxjs'
import { LivequeryClient } from '../src/LivequeryClient.js'
import { LivequeryCollection } from '../src/LivequeryCollection.js'
import { LivequeryMemoryStorage } from '../src/LivequeryMemoryStorage.js'
import { LIVEQUERY_OUTBOX_REF } from '../src/LivequeryOutbox.js'
import type { Doc, DocState, LivequeryStorage, LivequeryTransporter } from '../src/index.js'

type Todo = Doc<{ title: string, done?: boolean }>

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

async function waitUntil(check: () => boolean | Promise<boolean>, ms = 2000) {
    const started = Date.now()
    while (!(await check())) {
        if (Date.now() - started > ms) throw new Error('timed out')
        await tick(10)
    }
}

type Call = { op: 'add' | 'update' | 'delete', ref: string, id?: string, body?: Record<string, any> }

/** A server behind a switchable network: offline, every call fails with NETWORK_ERROR. */
function makeServer() {
    const docs = new Map<string, Record<string, any>>()
    const calls: Call[] = []
    const state = { online: true, next_id: 1, reject: undefined as undefined | { code: string, message: string, status?: number } }
    const guard = () => {
        if (!state.online) throw { code: 'NETWORK_ERROR', message: 'offline' }
        if (state.reject) throw state.reject
    }
    const status$ = new BehaviorSubject({ connected: true })
    const transporter: LivequeryTransporter = {
        query: () => NEVER,
        add: async (ref, body) => {
            guard()
            const doc = { ...body, id: `srv-${state.next_id++}` }
            calls.push({ op: 'add', ref, body })
            docs.set(doc.id, doc)
            return doc as any
        },
        update: async (ref, id, body) => {
            guard()
            calls.push({ op: 'update', ref, id, body })
            const doc = { ...docs.get(id), ...body, id }
            docs.set(id, doc)
            return doc as any
        },
        delete: async (ref, id) => {
            guard()
            calls.push({ op: 'delete', ref, id })
            const doc = docs.get(id)
            docs.delete(id)
            return doc as any
        },
        trigger: async () => ({}) as any,
        status$,
    }
    return { transporter, docs, calls, state, status$ }
}

function makeClient(server = makeServer(), storage: LivequeryStorage = new LivequeryMemoryStorage()) {
    const client = new LivequeryClient({ storage, transporters: { rest: server.transporter } })
    const col = new LivequeryCollection<Todo>(client, { ssr: false, mode: 'local-first' })
    col.initialize('todos')
    return { client, col, server, storage }
}

const item = (col: LivequeryCollection<Todo>, title: string) => col.items.value.find(d => d.value.title === title)?.value

// ─── queue on network failure ────────────────────────────────────────────────

describe('queue on network failure', () => {
    test('offline add — optimistic doc stays, marked _queued, entry persisted', async () => {
        const { client, col, server, storage } = makeClient()
        await tick()
        server.state.online = false

        const result = await col.add({ title: 'offline' }) as DocState<Todo>
        expect(result.id).toStartWith('local:')
        expect(result._queued).toBe(true)
        expect(result._adding).toBe(true)
        expect(item(col, 'offline')?._queued).toBe(true)

        const { documents } = await storage.query(LIVEQUERY_OUTBOX_REF)
        expect(documents).toHaveLength(1)
        expect(documents[0]).toMatchObject({ op: 'add', doc_id: result.id, attempts: 1 })
        client.destroy()
    })

    test('back online — the queue drains, the local id becomes the server id, flags clear', async () => {
        const { client, col, server } = makeClient()
        await tick()
        server.state.online = false
        const local = await col.add({ title: 'later' }) as DocState<Todo>

        server.state.online = true
        client.outbox.trigger()
        await waitUntil(() => item(col, 'later')?.id === 'srv-1')

        const doc = item(col, 'later')!
        expect(doc._adding).toBeUndefined()
        expect(doc._queued).toBeUndefined()
        expect(server.calls).toEqual([{ op: 'add', ref: 'todos', body: { title: 'later' } }])
        expect(col.items.value.some(d => d.value.id === local.id)).toBe(false)
        expect(await client.outbox.pending()).toEqual([])
        client.destroy()
    })

    test('writes replay in FIFO order', async () => {
        const { client, col, server } = makeClient()
        await tick()
        const a = await col.add({ title: 'a' }) as Todo
        const b = await col.add({ title: 'b' }) as Todo
        server.calls.length = 0
        server.state.online = false

        await col.update({ id: a.id, title: 'a2' })
        await col.delete(b.id)
        await col.add({ title: 'c' })

        server.state.online = true
        client.outbox.trigger()
        await waitUntil(async () => (await client.outbox.pending()).length === 0)
        expect(server.calls.map(c => `${c.op}:${c.id ?? c.body?.title}`)).toEqual(['update:srv-1', 'delete:srv-2', 'add:c'])
        client.destroy()
    })

    test('a 4xx is not queued — the error lands on the document', async () => {
        const { client, col, server } = makeClient()
        await tick()
        server.state.reject = { code: 'VALIDATION_FAILED', message: 'bad', status: 400 }

        const result = await col.add({ title: 'invalid' })
        expect(result).toBeUndefined()
        const doc = item(col, 'invalid')!
        expect(doc._adding_error?.code).toBe('VALIDATION_FAILED')
        expect(doc._queued).toBeUndefined()
        expect(await client.outbox.pending()).toEqual([])
        client.destroy()
    })

    test('a 5xx is queued like a network failure', async () => {
        const { client, col, server } = makeClient()
        await tick()
        server.state.reject = { code: 'INTERNAL', message: 'down', status: 503 }
        const result = await col.add({ title: 'retry-me' }) as DocState<Todo>
        expect(result._queued).toBe(true)
        expect(await client.outbox.pending()).toHaveLength(1)
        client.destroy()
    })

    test('server-first still throws when offline and queues nothing', async () => {
        const { client, server } = makeClient()
        const col = new LivequeryCollection<Todo>(client, { ssr: false, mode: 'server-first' })
        col.initialize('todos')
        await tick()
        server.state.online = false
        await expect(col.add({ title: 'x' })).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
        expect(await client.outbox.pending()).toEqual([])
        client.destroy()
    })
})

// ─── coalescing ──────────────────────────────────────────────────────────────

describe('coalescing', () => {
    test('add + update — one add with the latest fields, no update', async () => {
        const { client, col, server } = makeClient()
        await tick()
        server.state.online = false
        const local = await col.add({ title: 'draft', done: false }) as Todo
        await col.update({ id: local.id, title: 'final' })
        expect(await client.outbox.pending()).toHaveLength(1)

        server.state.online = true
        client.outbox.trigger()
        await waitUntil(() => item(col, 'final')?.id === 'srv-1')
        expect(server.calls).toEqual([{ op: 'add', ref: 'todos', body: { title: 'final', done: false } }])
        expect(item(col, 'final')?._prev).toBeUndefined()
        expect(item(col, 'final')?._updating).toBeUndefined()
        client.destroy()
    })

    test('add + delete — nothing reaches the server', async () => {
        const { client, col, server } = makeClient()
        await tick()
        server.state.online = false
        const local = await col.add({ title: 'gone' }) as Todo
        await col.delete(local.id)
        expect(await client.outbox.pending()).toEqual([])
        expect(item(col, 'gone')).toBeUndefined()

        server.state.online = true
        client.outbox.trigger()
        await tick(50)
        expect(server.calls).toEqual([])
        client.destroy()
    })

    test('update + update — one update carrying both fields', async () => {
        const { client, col, server } = makeClient()
        await tick()
        const doc = await col.add({ title: 't', done: false }) as Todo
        server.calls.length = 0
        server.state.online = false
        await col.update({ id: doc.id, title: 't2' })
        await col.update({ id: doc.id, done: true })
        expect(await client.outbox.pending()).toHaveLength(1)

        server.state.online = true
        client.outbox.trigger()
        await waitUntil(async () => (await client.outbox.pending()).length === 0)
        expect(server.calls).toEqual([{ op: 'update', ref: 'todos', id: doc.id, body: { title: 't2', done: true } }])
        expect(item(col, 't2')?._prev).toBeUndefined()
        client.destroy()
    })

    test('update + delete — only the delete is sent', async () => {
        const { client, col, server } = makeClient()
        await tick()
        const doc = await col.add({ title: 'u' }) as Todo
        server.calls.length = 0
        server.state.online = false
        await col.update({ id: doc.id, title: 'u2' })
        await col.delete(doc.id)
        const pending = await client.outbox.pending()
        expect(pending.map(e => e.op)).toEqual(['delete'])

        server.state.online = true
        client.outbox.trigger()
        await waitUntil(async () => (await client.outbox.pending()).length === 0)
        expect(server.calls).toEqual([{ op: 'delete', ref: 'todos', id: doc.id }])
        expect(col.items.value).toHaveLength(0)
        client.destroy()
    })
})

// ─── local id remap ──────────────────────────────────────────────────────────

describe('local id remap', () => {
    test('an update made while the add is in flight is sent to the server id', async () => {
        const server = makeServer()
        let release!: () => void
        const gate = new Promise<void>(r => { release = r })
        const add = server.transporter.add
        server.transporter.add = async (...args) => {
            await gate
            return await add(...args)
        }
        const { client, col } = makeClient(server)
        await tick()

        const adding = col.add({ title: 'slow' })
        await tick()
        const local = item(col, 'slow')!
        const updating = col.update({ id: local.id, title: 'slow-2' })
        await tick()
        const pending = await client.outbox.pending()
        expect(pending.map(e => [e.op, e.doc_id])).toEqual([['add', local.id], ['update', local.id]])

        release()
        await adding
        await updating
        expect(server.calls.map(c => [c.op, c.id ?? null, c.body])).toEqual([
            ['add', null, { title: 'slow' }],
            ['update', 'srv-1', { title: 'slow-2' }],
        ])
        expect(item(col, 'slow-2')).toMatchObject({ id: 'srv-1' })
        expect(item(col, 'slow-2')?._prev).toBeUndefined()
        client.destroy()
    })

    test('a delete made while the add is in flight deletes the created document', async () => {
        const server = makeServer()
        let release!: () => void
        const gate = new Promise<void>(r => { release = r })
        const add = server.transporter.add
        server.transporter.add = async (...args) => {
            await gate
            return await add(...args)
        }
        const { client, col } = makeClient(server)
        await tick()

        const adding = col.add({ title: 'short-lived' })
        await tick()
        const local = item(col, 'short-lived')!
        const deleting = col.delete(local.id)
        await tick()
        expect(item(col, 'short-lived')).toBeUndefined()

        release()
        await adding
        await deleting
        expect(server.calls.map(c => c.op)).toEqual(['add', 'delete'])
        expect(server.docs.size).toBe(0)
        client.destroy()
    })
})

// ─── resume ──────────────────────────────────────────────────────────────────

describe('resume', () => {
    test('a new client on the same storage drains what the previous one queued', async () => {
        const storage = new LivequeryMemoryStorage()
        const offline = makeServer()
        offline.state.online = false
        const first = makeClient(offline, storage)
        await tick()
        await first.col.add({ title: 'survives' })
        first.client.destroy()

        const server = makeServer()
        const second = makeClient(server, storage)
        await waitUntil(() => server.calls.length === 1)
        expect(server.calls[0]).toEqual({ op: 'add', ref: 'todos', body: { title: 'survives' } })
        await waitUntil(async () => (await storage.query(LIVEQUERY_OUTBOX_REF)).documents.length === 0)
        expect(await storage.get('todos', 'srv-1')).toMatchObject({ title: 'survives' })
        second.client.destroy()
    })

    test('status$ turning connected retries without waiting for the backoff', async () => {
        const { client, col, server } = makeClient()
        await tick()
        server.state.online = false
        server.status$.next({ connected: false })
        await col.add({ title: 'reconnect' })

        server.state.online = true
        server.status$.next({ connected: true })
        await waitUntil(() => item(col, 'reconnect')?.id === 'srv-1')
        client.destroy()
    })

    test('the global online event retries', async () => {
        const { client, col, server } = makeClient()
        await tick()
        server.state.online = false
        await col.add({ title: 'online-event' })

        server.state.online = true
        globalThis.dispatchEvent(new Event('online'))
        await waitUntil(() => item(col, 'online-event')?.id === 'srv-1')
        client.destroy()
    })

    test('shared storage — while another tab holds the drain lock, this one sends nothing', async () => {
        const navigator = globalThis.navigator as any
        const had_locks = 'locks' in navigator
        const original = navigator.locks
        const names: string[] = []
        navigator.locks = {
            request: async (name: string, _options: unknown, callback: (lock: unknown) => Promise<void>) => {
                names.push(name)
                return await callback(null)
            },
        }
        try {
            const storage = Object.assign(new LivequeryMemoryStorage(), { shared: 'indexeddb:app' })
            const { client, col, server } = makeClient(makeServer(), storage)
            const result = await col.add({ title: 'other-tab' }) as DocState<Todo>
            expect(result._queued).toBe(true)
            expect(server.calls).toEqual([])
            expect(names[0]).toBe('livequery-outbox:indexeddb:app')
            client.destroy()
        } finally {
            if (had_locks) navigator.locks = original
            else delete navigator.locks
        }
    })

    test('watching the outbox ref is refused', () => {
        const { client } = makeClient()
        expect(() => client.watch(LIVEQUERY_OUTBOX_REF, 'x', 'local-only')).toThrow()
        client.destroy()
    })
})
