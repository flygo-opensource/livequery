import { describe, test, expect } from 'bun:test'
import { ReplaySubject, Subject, filter as rxFilter, firstValueFrom, of, timeout } from 'rxjs'
import { LivequeryClient } from '../src/LivequeryClient.js'
import { LivequeryCollection } from '../src/LivequeryCollection.js'
import { LivequeryMemoryStorage } from '../src/LivequeryMemoryStorage.js'
import type { DataChangeEvent, Doc, LivequeryQueryResult, LivequeryTransporter } from '../src/index.js'

// @ts-ignore
global.window = {}

type Todo = Doc<{ title: string; done: boolean; priority?: number }>

const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms))

// Wait for a BehaviorSubject to satisfy a predicate, with timeout
function waitFor<T>(subject: { pipe: any }, pred: (v: T) => boolean, ms = 2000): Promise<T> {
    return firstValueFrom(subject.pipe(rxFilter(pred), timeout(ms)))
}

const waitForItems = (c: LivequeryCollection<any>, min = 1) =>
    waitFor<any[]>(c.items, items => items.length >= min)

const waitForLoading = (c: LivequeryCollection<any>, state: any) =>
    waitFor<any>(c.loading, l => l === state)

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeStorage() { return new LivequeryMemoryStorage() }

/** Transporter with ReplaySubject per ref — safe to emit before subscription */
function makeControllable() {
    const subjects = new Map<string, ReplaySubject<Partial<LivequeryQueryResult>>>()
    const calls = { add: [] as any[], update: [] as any[], delete: [] as any[], trigger: [] as any[] }

    const transporter: LivequeryTransporter = {
        query: (params) => {
            if (!subjects.has(params.ref)) subjects.set(params.ref, new ReplaySubject(100))
            return subjects.get(params.ref)!
        },
        add: async (_ref, doc) => {
            const r = { id: `srv-${Date.now()}`, ...doc } as Todo
            calls.add.push(r)
            return r
        },
        update: async (_ref, id, patch) => {
            const r = { id, ...patch } as Todo
            calls.update.push(r)
            return r
        },
        delete: async (_ref, id) => {
            calls.delete.push(id)
            return { id } as Todo
        },
        trigger: async (action) => {
            const r = { ok: true, action: action.action }
            calls.trigger.push(r)
            return r
        },
    }

    const emit = (ref: string, result: Partial<LivequeryQueryResult>) => {
        if (!subjects.has(ref)) subjects.set(ref, new ReplaySubject(100))
        subjects.get(ref)!.next(result)
    }
    const change = (ref: string, changes: DataChangeEvent[]) =>
        emit(ref, { changes, source: 'realtime' })

    return { transporter, emit, change, calls }
}

/** Simple transporter that emits a fixed response once */
function makeStaticTransporter(items: Todo[] = []): LivequeryTransporter {
    return {
        query: (_params) => of({
            changes: items.map(d => ({ collection_ref: 'todos', id: d.id, type: 'added' as const, data: d })),
            paging: { total: items.length, current: items.length },
            source: 'query' as const,
        }),
        add: async (_ref, doc) => ({ id: `srv-${Date.now()}`, ...doc } as Todo),
        update: async (_ref, id, patch) => ({ id, ...patch } as Todo),
        delete: async (_ref, id) => ({ id } as Todo),
        trigger: async () => ({} as any),
    }
}

function makeClient(storage = makeStorage(), transporter?: LivequeryTransporter) {
    return new LivequeryClient({
        storage,
        transporters: transporter ? { primary: transporter } : {},
    })
}

function values<T extends Doc>(c: LivequeryCollection<T>) {
    return c.items.value.map(i => i.value)
}

// ─── server-first query ───────────────────────────────────────────────────────

describe('server-first query', () => {
    test('items populated from transporter on auto-query', async () => {
        const client = makeClient(makeStorage(), makeStaticTransporter([
            { id: '1', title: 'A', done: false },
            { id: '2', title: 'B', done: true },
        ]))
        const collection = new LivequeryCollection<Todo>(client, { mode: 'server-first' })
        collection.initialize('todos')

        await waitForItems(collection, 2)
        expect(values(collection).map(d => d.title)).toEqual(['A', 'B'])
    })

    test('loading transitions from all → null after query completes', async () => {
        const client = makeClient(makeStorage(), makeStaticTransporter([]))
        const collection = new LivequeryCollection<Todo>(client, { mode: 'server-first' })
        collection.initialize('todos')

        await waitForLoading(collection, null)
        expect(collection.loading.value).toBeNull()
    })

    test('error from transporter sets error subject', async () => {
        const { transporter, emit } = makeControllable()
        const client = makeClient(makeStorage(), transporter)
        const collection = new LivequeryCollection<Todo>(client, { mode: 'server-first' })
        collection.initialize('todos')

        emit('todos', { error: { code: 'NOT_FOUND', message: 'not found' }, source: 'query' })

        await waitFor<any>(collection.error, e => e?.code === 'NOT_FOUND')
        expect(collection.error.value?.code).toBe('NOT_FOUND')
    })

    test('resetError clears error subject', async () => {
        const { transporter, emit } = makeControllable()
        const client = makeClient(makeStorage(), transporter)
        const collection = new LivequeryCollection<Todo>(client, { mode: 'server-first' })
        collection.initialize('todos')

        emit('todos', { error: { code: 'ERR', message: 'oops' }, source: 'query' })
        await waitFor<any>(collection.error, e => e !== null)

        collection.resetError()
        expect(collection.error.value).toBeNull()
    })
})

// ─── realtime updates ─────────────────────────────────────────────────────────

describe('realtime updates', () => {
    test('modified event updates only the affected item without replacing the array', async () => {
        const { transporter, emit, change } = makeControllable()
        const client = makeClient(makeStorage(), transporter)
        const collection = new LivequeryCollection<Todo>(client, { mode: 'server-first' })
        collection.initialize('todos')

        emit('todos', {
            changes: [
                { collection_ref: 'todos', id: '1', type: 'added', data: { id: '1', title: 'A', done: false } },
                { collection_ref: 'todos', id: '2', type: 'added', data: { id: '2', title: 'B', done: false } },
            ],
            source: 'query',
        })
        await waitForItems(collection, 2)

        const item1 = collection.items.value[0]
        const item2 = collection.items.value[1]
        const beforeArray = collection.items.value

        change('todos', [{ collection_ref: 'todos', id: '1', type: 'modified', data: { done: true } }])
        await tick()

        expect(item1.value.done).toBe(true)
        expect(item2.value.done).toBe(false)
        // items array reference unchanged for modify-only event
        expect(collection.items.value).toBe(beforeArray)
    })

    test('removed event removes the item', async () => {
        const { transporter, emit, change } = makeControllable()
        const client = makeClient(makeStorage(), transporter)
        const collection = new LivequeryCollection<Todo>(client, { mode: 'server-first' })
        collection.initialize('todos')

        emit('todos', {
            changes: [
                { collection_ref: 'todos', id: '1', type: 'added', data: { id: '1', title: 'A', done: false } },
                { collection_ref: 'todos', id: '2', type: 'added', data: { id: '2', title: 'B', done: false } },
            ],
            source: 'query',
        })
        await waitForItems(collection, 2)

        change('todos', [{ collection_ref: 'todos', id: '1', type: 'removed' }])
        await waitFor<any[]>(collection.items, items => items.length === 1)

        expect(values(collection).map(d => d.id)).toEqual(['2'])
    })

    test('added event appends new item', async () => {
        const { transporter, emit, change } = makeControllable()
        const client = makeClient(makeStorage(), transporter)
        const collection = new LivequeryCollection<Todo>(client, { mode: 'server-first' })
        collection.initialize('todos')

        emit('todos', {
            changes: [{ collection_ref: 'todos', id: '1', type: 'added', data: { id: '1', title: 'A', done: false } }],
            source: 'query',
        })
        await waitForItems(collection, 1)

        change('todos', [{ collection_ref: 'todos', id: '2', type: 'added', data: { id: '2', title: 'B', done: false } }])
        await waitForItems(collection, 2)

        expect(values(collection).map(d => d.id)).toEqual(['1', '2'])
    })

    test('wildcard removed (*) resets collection', async () => {
        const { transporter, emit, change } = makeControllable()
        const client = makeClient(makeStorage(), transporter)
        const collection = new LivequeryCollection<Todo>(client, { mode: 'server-first' })
        collection.initialize('todos')

        emit('todos', {
            changes: [{ collection_ref: 'todos', id: '1', type: 'added', data: { id: '1', title: 'A', done: false } }],
            source: 'query',
        })
        await waitForItems(collection, 1)

        change('todos', [{ collection_ref: 'todos', id: '*', type: 'removed' }])
        await waitFor<any[]>(collection.items, items => items.length === 0)

        expect(collection.loading.value).toBeNull()
        expect(collection.summary.value).toEqual({})
    })

    test('multiple collections on same ref both receive broadcast', async () => {
        const { transporter, emit, change } = makeControllable()
        const client = makeClient(makeStorage(), transporter)
        const c1 = new LivequeryCollection<Todo>(client, { mode: 'server-first' })
        const c2 = new LivequeryCollection<Todo>(client, { mode: 'server-first' })
        c1.initialize('todos')
        c2.initialize('todos')

        const initial = {
            changes: [{ collection_ref: 'todos', id: '1', type: 'added' as const, data: { id: '1', title: 'A', done: false } }],
            source: 'query' as const,
        }
        emit('todos', initial)
        await Promise.all([waitForItems(c1, 1), waitForItems(c2, 1)])

        change('todos', [{ collection_ref: 'todos', id: '1', type: 'modified', data: { done: true } }])
        await tick()

        expect(c1.items.value[0].value.done).toBe(true)
        expect(c2.items.value[0].value.done).toBe(true)
    })
})

// ─── cache-first ──────────────────────────────────────────────────────────────

describe('cache-first query', () => {
    test('serves storage immediately, transporter refreshes in background', async () => {
        const storage = makeStorage()
        await storage.add('todos', { id: '1', title: 'Cached', done: false })

        const { transporter, emit } = makeControllable()
        const client = makeClient(storage, transporter)
        const collection = new LivequeryCollection<Todo>(client, { mode: 'cache-first' })
        collection.initialize('todos')
        await tick()

        expect(values(collection).some(d => d.title === 'Cached')).toBe(true)

        emit('todos', {
            changes: [{ collection_ref: 'todos', id: '2', type: 'added', data: { id: '2', title: 'Fresh', done: false } }],
            source: 'query',
        })
        await waitForItems(collection, 2)

        expect(values(collection).some(d => d.title === 'Fresh')).toBe(true)
    })
})

// ─── local-only ───────────────────────────────────────────────────────────────

describe('local-only', () => {
    test('add stores locally with _local_only flag, transporter never called', async () => {
        const storage = makeStorage()
        const { transporter, calls } = makeControllable()
        const client = makeClient(storage, transporter)
        const collection = new LivequeryCollection<Todo>(client, { mode: 'local-only', lazy: true })
        collection.initialize('todos')

        await collection.add({ title: 'Draft', done: false })

        const stored = await storage.query<Todo>('todos')
        expect(stored.documents).toHaveLength(1)
        expect((stored.documents[0] as any)._local_only).toBe(true)
        expect(calls.add).toHaveLength(0)
    })

    test('delete removes from storage only', async () => {
        const storage = makeStorage()
        const client = makeClient(storage)
        const collection = new LivequeryCollection<Todo>(client, { mode: 'local-only', lazy: true })
        collection.initialize('todos')

        await collection.add({ title: 'Draft', done: false })
        const stored = await storage.query<Todo>('todos')
        const id = stored.documents[0].id

        await collection.delete(id)
        const after = await storage.query<Todo>('todos')
        expect(after.documents).toHaveLength(0)
    })

    test('update patches storage without contacting transporter', async () => {
        const storage = makeStorage()
        const { transporter, calls } = makeControllable()
        const client = makeClient(storage, transporter)
        const collection = new LivequeryCollection<Todo>(client, { mode: 'local-only', lazy: true })
        collection.initialize('todos')

        await collection.add({ title: 'Draft', done: false })
        const stored = await storage.query<Todo>('todos')
        const id = stored.documents[0].id

        await collection.update({ id, done: true })

        const after = await storage.query<Todo>('todos')
        expect(after.documents[0].done).toBe(true)
        expect(calls.update).toHaveLength(0)
    })
})

// ─── mutation mode defaults ───────────────────────────────────────────────────

describe('mutation mode defaults to options.mode', () => {
    test('local-only collection: add defaults to local-only mode', async () => {
        const storage = makeStorage()
        const { transporter, calls } = makeControllable()
        const client = makeClient(storage, transporter)
        const collection = new LivequeryCollection<Todo>(client, { mode: 'local-only', lazy: true })
        collection.initialize('todos')

        await collection.add({ title: 'Local', done: false })

        const stored = await storage.query<Todo>('todos')
        expect((stored.documents[0] as any)._local_only).toBe(true)
        expect(calls.add).toHaveLength(0)
    })

    test('explicit override takes precedence over options.mode', async () => {
        const { transporter, calls } = makeControllable()
        const client = makeClient(makeStorage(), transporter)
        const collection = new LivequeryCollection<Todo>(client, { mode: 'local-only', lazy: true })
        collection.initialize('todos')

        await collection.add({ title: 'Force', done: false }, 'server-first')
        expect(calls.add).toHaveLength(1)
    })

    test('cache-first falls back to server-first for mutations', async () => {
        const { transporter, calls } = makeControllable()
        const client = makeClient(makeStorage(), transporter)
        const collection = new LivequeryCollection<Todo>(client, { mode: 'cache-first', lazy: true })
        collection.initialize('todos')

        await collection.add({ title: 'Item', done: false })
        expect(calls.add).toHaveLength(1)
    })

    test('add returns single doc for object input, array for array input', async () => {
        const { transporter } = makeControllable()
        const client = makeClient(makeStorage(), transporter)
        const collection = new LivequeryCollection<Todo>(client, { mode: 'server-first', lazy: true })
        collection.initialize('todos')

        const single = await collection.add({ title: 'One', done: false })
        expect(Array.isArray(single)).toBe(false)

        const many = await collection.add([
            { title: 'A', done: false },
            { title: 'B', done: false },
        ])
        expect(Array.isArray(many)).toBe(true)
        expect((many as any[]).length).toBe(2)
    })
})

// ─── trigger ──────────────────────────────────────────────────────────────────

describe('trigger', () => {
    test('calls transporter trigger and returns result', async () => {
        const { transporter, calls } = makeControllable()
        const client = makeClient(makeStorage(), transporter)
        const collection = new LivequeryCollection<Todo>(client, { lazy: true })
        collection.initialize('todos')

        const result = await collection.trigger('archive-done', { olderThan: 1000 })

        expect(calls.trigger).toHaveLength(1)
        expect(calls.trigger[0].action).toBe('archive-done')
        expect((result as any).ok).toBe(true)
    })
})

// ─── sort ─────────────────────────────────────────────────────────────────────

describe('sort', () => {
    test('local-only: sort in memory by field asc/desc', async () => {
        const client = makeClient()
        const collection = new LivequeryCollection<Todo>(client, { mode: 'local-only', lazy: true })
        collection.initialize('todos')

        await collection.add([
            { title: 'B', done: false, priority: 2 },
            { title: 'A', done: false, priority: 1 },
            { title: 'C', done: false, priority: 3 },
        ])
        await tick()

        await collection.sort('priority', 'asc')
        expect(values(collection).map(d => d.priority)).toEqual([1, 2, 3])

        await collection.sort('priority', 'desc')
        expect(values(collection).map(d => d.priority)).toEqual([3, 2, 1])
    })

    test('local-only: sort reset restores insertion order', async () => {
        const client = makeClient()
        const collection = new LivequeryCollection<Todo>(client, { mode: 'local-only', lazy: true })
        collection.initialize('todos')

        await collection.add([
            { title: 'B', done: false, priority: 2 },
            { title: 'A', done: false, priority: 1 },
        ])
        await tick()

        await collection.sort('priority', 'asc')
        await collection.sort('reset', 'asc')
        expect(values(collection).map(d => d.title)).toEqual(['B', 'A'])
    })
})

// ─── select ───────────────────────────────────────────────────────────────────

describe('select', () => {
    test('select all marks every item and updates selected set', async () => {
        const client = makeClient()
        const collection = new LivequeryCollection<Todo>(client, { mode: 'local-only', lazy: true })
        collection.initialize('todos')

        await collection.add([
            { title: 'A', done: false },
            { title: 'B', done: false },
        ])
        await tick()

        collection.select('all')
        await tick()

        expect(collection.selected.value.size).toBe(2)
        expect(values(collection).every(d => d._selected)).toBe(true)
    })

    test('select none clears selection', async () => {
        const client = makeClient()
        const collection = new LivequeryCollection<Todo>(client, { mode: 'local-only', lazy: true })
        collection.initialize('todos')

        await collection.add([{ title: 'A', done: false }])
        await tick()

        collection.select('all')
        await tick()
        collection.select('none')
        await tick()

        expect(collection.selected.value.size).toBe(0)
    })

    test('select toggle flips single item selection', async () => {
        const client = makeClient()
        const collection = new LivequeryCollection<Todo>(client, { mode: 'local-only', lazy: true })
        collection.initialize('todos')

        await collection.add([{ title: 'A', done: false }])
        await tick()

        const id = values(collection)[0].id
        collection.select('toggle', id)
        await tick()
        expect(collection.selected.value.has(id)).toBe(true)

        collection.select('toggle', id)
        await tick()
        expect(collection.selected.value.has(id)).toBe(false)
    })
})

// ─── watch ────────────────────────────────────────────────────────────────────

describe('watch', () => {
    test('emits pairwise when watched field changes', async () => {
        const { transporter, emit, change } = makeControllable()
        const client = makeClient(makeStorage(), transporter)
        const collection = new LivequeryCollection<Todo>(client, { mode: 'server-first' })
        collection.initialize('todos')

        emit('todos', {
            changes: [{ collection_ref: 'todos', id: '1', type: 'added', data: { id: '1', title: 'A', done: false } }],
            source: 'query',
        })
        await waitForItems(collection, 1)

        const seen: Array<[boolean, boolean]> = []
        const sub = collection.watch((prev, next) => prev.done !== next.done)
            .subscribe(([prev, next]) => seen.push([prev.done, next.done]))

        change('todos', [{ collection_ref: 'todos', id: '1', type: 'modified', data: { done: true } }])
        await tick()

        expect(seen).toEqual([[false, true]])
        sub.unsubscribe()
    })

    test('does not emit when unrelated field changes', async () => {
        const { transporter, emit, change } = makeControllable()
        const client = makeClient(makeStorage(), transporter)
        const collection = new LivequeryCollection<Todo>(client, { mode: 'server-first' })
        collection.initialize('todos')

        emit('todos', {
            changes: [{ collection_ref: 'todos', id: '1', type: 'added', data: { id: '1', title: 'A', done: false } }],
            source: 'query',
        })
        await waitForItems(collection, 1)

        const seen: any[] = []
        const sub = collection.watch((prev, next) => prev.done !== next.done)
            .subscribe(pair => seen.push(pair))

        change('todos', [{ collection_ref: 'todos', id: '1', type: 'modified', data: { title: 'B' } }])
        await tick()

        expect(seen).toHaveLength(0)
        sub.unsubscribe()
    })
})

// ─── pagination ───────────────────────────────────────────────────────────────

describe('pagination', () => {
    test('loadMore appends next page', async () => {
        const { transporter, emit } = makeControllable()
        const client = makeClient(makeStorage(), transporter)
        const collection = new LivequeryCollection<Todo>(client, { mode: 'server-first' })
        collection.initialize('todos')

        emit('todos', {
            changes: [{ collection_ref: 'todos', id: '1', type: 'added', data: { id: '1', title: 'A', done: false } }],
            paging: { total: 2, current: 1, next: { cursor: 'cursor-2', count: 1 } },
            source: 'query',
        })
        await waitForItems(collection, 1)
        await waitFor<any>(collection.paging, p => p.next?.cursor === 'cursor-2')

        collection.loadMore()
        await tick()

        emit('todos', {
            changes: [{ collection_ref: 'todos', id: '2', type: 'added', data: { id: '2', title: 'B', done: false } }],
            paging: { total: 2, current: 2 },
            source: 'query',
        })
        await waitForItems(collection, 2)

        expect(values(collection).map(d => d.id)).toContain('2')
    })

    test('loadMore does nothing when no next cursor', async () => {
        const client = makeClient(makeStorage(), makeStaticTransporter([]))
        const collection = new LivequeryCollection<Todo>(client, { mode: 'server-first' })
        collection.initialize('todos')
        await waitForLoading(collection, null)

        await collection.loadMore()
        expect(collection.items.value).toHaveLength(0)
    })
})

// ─── document ref ─────────────────────────────────────────────────────────────

describe('document ref', () => {
    test('derives collection_ref from document path', () => {
        const client = makeClient()
        const collection = new LivequeryCollection<Todo>(client, { lazy: true })
        collection.initialize('todos/todo-1')

        expect(collection.ref).toBe('todos/todo-1')
        expect(collection.collection_ref).toBe('todos')
    })
})

// ─── summary ─────────────────────────────────────────────────────────────────

describe('summary', () => {
    test('summary subject updated from transporter result', async () => {
        const { transporter, emit } = makeControllable()
        const client = makeClient(makeStorage(), transporter)
        const collection = new LivequeryCollection<Todo>(client, { mode: 'server-first' })
        collection.initialize('todos')

        emit('todos', {
            changes: [],
            summary: { open: 5, closed: 3 },
            paging: { total: 0, current: 0 },
            source: 'query',
        })
        await waitFor<any>(collection.summary, s => s.open === 5)

        expect(collection.summary.value).toEqual({ open: 5, closed: 3 })
    })
})
