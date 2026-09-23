import { describe, expect, test } from 'bun:test'
import { ReplaySubject } from 'rxjs'
import { LivequeryClient } from '../src/LivequeryClient.js'
import { LivequeryCollection } from '../src/LivequeryCollection.js'
import { LivequeryMemoryStorage } from '../src/LivequeryMemoryStorage.js'
import { AddLock } from '../src/helpers/AddLock.js'
import type { Doc, LivequeryQueryResult, LivequeryTransporter } from '../src/index.js'

type Todo = Doc<{ title: string, done?: boolean }>

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(r => { resolve = r })
    return { promise, resolve }
}

// ─── AddLock ─────────────────────────────────────────────────────────────────

describe('AddLock', () => {
    test('two concurrent adds — the lock holds until the second one is released', () => {
        const lock = new AddLock()
        const a = lock.acquire('todos')
        const b = lock.acquire('todos')
        let released = 0
        lock.pending('todos').subscribe(() => released++)

        a[Symbol.dispose]()
        expect(lock.locked('todos')).toBe(true)
        expect(released).toBe(0)

        b[Symbol.dispose]()
        expect(lock.locked('todos')).toBe(false)
        expect(released).toBe(1)
    })

    test('pending emits immediately when nothing is in flight', () => {
        const lock = new AddLock()
        let released = 0
        lock.pending('todos').subscribe(() => released++)
        expect(released).toBe(1)
    })

    test('disposing twice does not release a lock held by someone else', () => {
        const lock = new AddLock()
        const a = lock.acquire('todos')
        lock.acquire('todos')
        a[Symbol.dispose]()
        a[Symbol.dispose]()
        expect(lock.locked('todos')).toBe(true)
    })
})

// ─── client ──────────────────────────────────────────────────────────────────

function makeTransporter() {
    const stream = new ReplaySubject<Partial<LivequeryQueryResult>>(100)
    const adds: Array<ReturnType<typeof deferred<Todo>>> = []
    const updates: Array<{ id: string, patch: Record<string, any> }> = []
    const transporter: LivequeryTransporter = {
        query: () => stream,
        add: async () => {
            const d = deferred<Todo>()
            adds.push(d)
            return await d.promise as any
        },
        update: async (_ref, id, patch) => {
            updates.push({ id, patch })
            return { id, ...patch } as any
        },
        delete: async (_ref, id) => ({ id }) as any,
        trigger: async () => ({}) as any,
    }
    return { transporter, stream, adds, updates }
}

describe('realtime added events wait for every add in flight', () => {
    test('an echo arriving after the first of two adds resolves is still held back', async () => {
        const { transporter, stream, adds } = makeTransporter()
        const client = new LivequeryClient({ storage: new LivequeryMemoryStorage(), transporters: { t: transporter } })
        const col = new LivequeryCollection<Todo>(client, { ssr: false, mode: 'server-first' })
        col.initialize('todos')
        stream.next({ changes: [], source: 'query' })
        await tick()

        const pending = col.add([{ title: 'A' }, { title: 'B' }])
        await tick()
        expect(adds).toHaveLength(2)

        adds[0]!.resolve({ id: 'srv-a', title: 'A' })
        await tick()
        stream.next({ changes: [{ collection_ref: 'todos', id: 'srv-b', type: 'added', data: { id: 'srv-b', title: 'B' } }], source: 'realtime' })
        await tick()
        expect(col.items.value.map(d => d.value.id)).not.toContain('srv-b')

        adds[1]!.resolve({ id: 'srv-b', title: 'B' })
        await pending
        await tick()
        expect(col.items.value.map(d => d.value.id)).toContain('srv-b')
    })
})

describe('server-first update', () => {
    test('_prev-driven payload is the edited fields only, without id', async () => {
        const { transporter, stream, updates } = makeTransporter()
        const storage = new LivequeryMemoryStorage()
        const client = new LivequeryClient({ storage, transporters: { t: transporter } })
        const col = new LivequeryCollection<Todo>(client, { ssr: false, mode: 'server-first' })
        col.initialize('todos')
        stream.next({ changes: [{ collection_ref: 'todos', id: '1', type: 'added', data: { id: '1', title: 'old', done: false } }], source: 'query' })
        await tick()

        await col.update({ id: '1', title: 'new' })
        expect(updates).toEqual([{ id: '1', patch: { title: 'new' } }])
    })
})
