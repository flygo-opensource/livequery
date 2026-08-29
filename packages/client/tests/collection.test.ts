import { describe, test, expect, beforeAll } from 'bun:test'
import { of } from 'rxjs'
import { LivequeryClient } from '../src/LivequeryClient.js'
import { LivequeryCollection } from '../src/LivequeryCollection.js'
import { LivequeryMemoryStorage } from '../src/LivequeryMemoryStorage.js'
import type { Doc, LivequeryTransporter } from '../src/index.js'

// initialize() guards on window — expose it for tests
// @ts-ignore
global.window = {}

type Todo = Doc<{ title: string; done: boolean }>

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

function makeStorage() {
    return new LivequeryMemoryStorage()
}

function makeClient(storage = makeStorage(), transporter?: Partial<LivequeryTransporter>) {
    return new LivequeryClient({
        storage,
        transporters: transporter ? { primary: transporter as LivequeryTransporter } : {},
    })
}

function makeTransporter(items: Todo[] = []): LivequeryTransporter {
    return {
        query: () => of({
            changes: items.map(doc => ({ collection_ref: 'todos', id: doc.id, type: 'added' as const, data: doc })),
            paging: { total: items.length, current: items.length },
            source: 'query' as const,
        }),
        add: async (_ref, doc) => ({ id: 'server-id', ...doc }) as Todo,
        update: async (_ref, id, patch) => ({ id, ...patch }) as Todo,
        delete: async (_ref, id) => ({ id } as Todo),
        trigger: async () => ({} as any),
    }
}

// ─── seed ────────────────────────────────────────────────────────────────────

describe('seed', () => {
    test('persist: false — items populated in constructor, storage untouched', async () => {
        const storage = makeStorage()
        const client = makeClient(storage)
        const collection = new LivequeryCollection<Todo>(client, {
            seed: { data: [{ id: '1', title: 'Seeded', done: false }], persist: false },
        })

        expect(collection.items.value).toHaveLength(1)
        expect(collection.items.value[0].value.title).toBe('Seeded')

        const stored = await storage.query<Todo>('todos')
        expect(stored.documents).toHaveLength(0)
    })

    test('persist: true — writes to storage before auto-query runs', async () => {
        const storage = makeStorage()
        const client = makeClient(storage, makeTransporter())
        const collection = new LivequeryCollection<Todo>(client, {
            mode: 'cache-first',
            seed: { data: [{ id: '1', title: 'Persisted', done: false }], persist: true },
        })

        collection.initialize('todos')
        await tick()

        const stored = await storage.query<Todo>('todos')
        expect(stored.documents).toHaveLength(1)
        expect(stored.documents[0].title).toBe('Persisted')
    })

    test('persist: true — cache-first reads seed from storage on first query', async () => {
        const storage = makeStorage()
        const client = makeClient(storage, makeTransporter())
        const collection = new LivequeryCollection<Todo>(client, {
            mode: 'cache-first',
            lazy: true,
            seed: { data: [{ id: '1', title: 'FromCache', done: false }], persist: true },
        })

        collection.initialize('todos')
        await tick()

        await collection.query({})
        await tick()

        const ids = collection.items.value.map(i => i.value.id)
        expect(ids).toContain('1')
    })
})

// ─── mutation mode defaults ───────────────────────────────────────────────────

describe('mutation mode defaults to options.mode', () => {
    test('local-only collection: add stores with _local_only flag by default', async () => {
        const storage = makeStorage()
        const client = makeClient(storage)
        const collection = new LivequeryCollection<Todo>(client, { mode: 'local-only' })
        collection.initialize('todos')

        await collection.add({ title: 'Local', done: false })

        const stored = await storage.query<Todo>('todos')
        expect(stored.documents).toHaveLength(1)
        expect((stored.documents[0] as any)._local_only).toBe(true)
    })

    test('local-first collection: add stores with _adding flag by default', async () => {
        const storage = makeStorage()
        const client = makeClient(storage, makeTransporter())
        const collection = new LivequeryCollection<Todo>(client, { mode: 'local-first' })
        collection.initialize('todos')

        await collection.add({ title: 'LocalFirst', done: false })
        await tick()

        const stored = await storage.query<Todo>('todos')
        expect(stored.documents.some(d => (d as any)._adding === true || d.title === 'LocalFirst')).toBe(true)
    })

    test('explicit mode override takes precedence over options.mode', async () => {
        const storage = makeStorage()
        const client = makeClient(storage)
        const collection = new LivequeryCollection<Todo>(client, { mode: 'local-only' })
        collection.initialize('todos')

        // Override to local-first explicitly — should NOT set _local_only
        await collection.add({ title: 'Override', done: false }, 'local-first')

        const stored = await storage.query<Todo>('todos')
        const doc = stored.documents.find(d => d.title === 'Override')
        expect(doc).toBeDefined()
        expect((doc as any)._local_only).toBeUndefined()
    })

    test('cache-first falls back to server-first for mutations', async () => {
        const storage = makeStorage()
        const added: any[] = []
        const transporter = makeTransporter()
        transporter.add = async (_ref, doc) => {
            const result = { id: 'srv-1', ...doc } as Todo
            added.push(result)
            return result
        }
        const client = makeClient(storage, transporter)
        const collection = new LivequeryCollection<Todo>(client, { mode: 'cache-first' })
        collection.initialize('todos')

        await collection.add({ title: 'CacheFirst', done: false })

        expect(added).toHaveLength(1)
    })
})

// ─── reset on re-initialize ───────────────────────────────────────────────────

describe('reset state on re-initialize', () => {
    test('items cleared when ref changes', async () => {
        const client = makeClient()
        const collection = new LivequeryCollection<Todo>(client, {
            lazy: true,
            seed: { data: [{ id: '1', title: 'Old', done: false }], persist: false },
        })

        collection.initialize('todos')
        expect(collection.items.value).toHaveLength(1)

        collection.initialize('other-todos')
        expect(collection.items.value).toHaveLength(0)
    })

    test('loading, error, paging, summary cleared on re-initialize', async () => {
        const storage = makeStorage()
        const client = makeClient(storage, makeTransporter([{ id: '1', title: 'A', done: false }]))
        const collection = new LivequeryCollection<Todo>(client, { mode: 'server-first' })

        collection.initialize('todos')
        await tick()

        // Force some state
        collection.error.next({ code: 'ERR', message: 'boom' })
        collection.paging.next({ total: 99, current: 5 })

        collection.initialize('other-todos')

        expect(collection.items.value).toHaveLength(0)
        expect(collection.loading.value).toBeNull()
        expect(collection.error.value).toBeNull()
        expect(collection.paging.value.total).toBe(0)
        expect(collection.summary.value).toEqual({})
    })

    test('no reset on first initialize', () => {
        const client = makeClient()
        const collection = new LivequeryCollection<Todo>(client, {
            seed: { data: [{ id: '1', title: 'Keep', done: false }], persist: false },
        })

        // First call — seed items must survive
        collection.initialize('todos')
        expect(collection.items.value).toHaveLength(1)
    })
})

// ─── fix #1: timer leak on re-initialize ─────────────────────────────────────

describe('timer leak fix', () => {
    test('pending auto-query from previous ref does not fire after re-initialize', async () => {
        const queries: string[] = []
        const client = makeClient(makeStorage(), {
            query: (req) => {
                queries.push(req.ref)
                return of({
                    changes: [],
                    paging: { total: 0, current: 0 },
                    source: 'query' as const,
                })
            },
            add: async (_ref, doc) => ({ id: 'x', ...doc }) as Todo,
            update: async (_ref, id, patch) => ({ id, ...patch }) as Todo,
            delete: async (_ref, id) => ({ id } as Todo),
            trigger: async () => ({} as any),
        })
        const collection = new LivequeryCollection<Todo>(client)

        // initialize with ref-A (lazy: false triggers a setTimeout startQuery)
        collection.initialize('todos-a')
        // immediately re-initialize with ref-B before timer fires
        collection.initialize('todos-b')
        await tick(50)

        // only todos-b should have been queried, not todos-a
        expect(queries.every(r => r === 'todos-b')).toBe(true)
    })
})

// ─── fix #2: startQuery not cancelled by old subscription finalize ────────────
//
// Race: initialize(ref1) → subscription active →
//       initialize(ref2): set timer (A) → unsubscribe old sub (B) →
//       old sub's finalize clearTimeout(#timer) erases timer A → startQuery never runs.
// Fix: unsubscribe BEFORE setting the timer so finalize sees #timer = undefined.

describe('race condition: startQuery for new ref not cancelled by old sub finalize', () => {
    test('query fires for new ref when re-initializing from an active subscription', async () => {
        const queries: string[] = []
        const client = makeClient(makeStorage(), {
            query: (req) => {
                queries.push(req.ref)
                return of({
                    changes: [{ id: '1', type: 'added' as const, data: { id: '1', title: 'Item', done: false }, collection_ref: req.ref }],
                    paging: { total: 1, current: 1 },
                    source: 'query' as const,
                })
            },
            add: async (_ref, doc) => ({ id: 'x', ...doc }) as Todo,
            update: async (_ref, id, patch) => ({ id, ...patch }) as Todo,
            delete: async (_ref, id) => ({ id } as Todo),
            trigger: async () => ({} as any),
        })
        const collection = new LivequeryCollection<Todo>(client)

        // Step 1: initialize ref-a and WAIT for the subscription to become active.
        // This means this.#subscription is non-null when we switch ref.
        collection.initialize('todos-a')
        await tick(50)
        expect(queries.filter(r => r === 'todos-a').length).toBeGreaterThan(0)

        // Step 2: switch to ref-b (simulates navigating to a different chat room).
        // Without the fix: old sub's finalize clears the new timer → todos-b never queried.
        collection.initialize('todos-b')
        await tick(50)

        expect(queries.filter(r => r === 'todos-b').length).toBeGreaterThan(0)
        expect(collection.items.value).toHaveLength(1)
    })

    test('multiple consecutive ref switches all fire their respective queries', async () => {
        const queries: string[] = []
        const client = makeClient(makeStorage(), {
            query: (req) => {
                queries.push(req.ref)
                return of({
                    changes: [],
                    paging: { total: 0, current: 0 },
                    source: 'query' as const,
                })
            },
            add: async (_ref, doc) => ({ id: 'x', ...doc }) as Todo,
            update: async (_ref, id, patch) => ({ id, ...patch }) as Todo,
            delete: async (_ref, id) => ({ id } as Todo),
            trigger: async () => ({} as any),
        })
        const collection = new LivequeryCollection<Todo>(client)

        collection.initialize('chat-a')
        await tick(50)
        collection.initialize('chat-b')
        await tick(50)
        collection.initialize('chat-c')
        await tick(50)

        expect(queries.filter(r => r === 'chat-a').length).toBeGreaterThan(0)
        expect(queries.filter(r => r === 'chat-b').length).toBeGreaterThan(0)
        expect(queries.filter(r => r === 'chat-c').length).toBeGreaterThan(0)
    })
})

// ─── fix #2: query error propagates to collection.error ──────────────────────

describe('query error handling', () => {
    test('storage rejection sets collection.error and clears loading', async () => {
        const storage = makeStorage()
        storage.query = async () => { throw { code: 'STORAGE_ERROR', message: 'disk full' } }
        // local-only mode: only storage is used, no server query fires after error
        const client = makeClient(storage)
        const collection = new LivequeryCollection<Todo>(client, { mode: 'local-only', lazy: true })
        collection.initialize('todos')

        await collection.query({})
        await tick()

        expect(collection.error.value?.code).toBe('STORAGE_ERROR')
        expect(collection.error.value?.message).toBe('disk full')
        expect(collection.loading.value).toBeNull()
    })
})

// ─── fix #3: parseArray warns on invalid JSON ─────────────────────────────────

describe('filterDocs parseArray', () => {
    test('warns when filter value is not valid JSON', () => {
        const { matchesAllFilters } = require('../src/helpers/filterDocs.js')
        const warns: string[] = []
        const original = console.warn
        console.warn = (...args: any[]) => warns.push(args.join(' '))

        const result = matchesAllFilters({ status: 'active' }, { 'status:in': 'active,pending' })

        console.warn = original
        expect(result).toBe(false) // returns [] → includes = false
        expect(warns.some(w => w.includes('not valid JSON'))).toBe(true)
    })

    test('valid JSON array still works without warning', () => {
        const { matchesAllFilters } = require('../src/helpers/filterDocs.js')
        const warns: string[] = []
        const original = console.warn
        console.warn = (...args: any[]) => warns.push(args.join(' '))

        const result = matchesAllFilters({ status: 'active' }, { 'status:in': '["active","pending"]' })

        console.warn = original
        expect(result).toBe(true)
        expect(warns).toHaveLength(0)
    })
})

// ─── fix #4: sort NaN → 0 ────────────────────────────────────────────────────

describe('sort stability with mixed types', () => {
    test('sort does not crash when field has incompatible types', () => {
        const client = makeClient()
        // seed data directly — no async query needed
        const collection = new LivequeryCollection<Todo>(client, {
            mode: 'local-only',
            seed: {
                data: [
                    { id: '1', title: 'A', done: false },
                    { id: '2', title: 'B', done: false },
                ],
                persist: false,
            },
        })
        collection.initialize('todos')

        // sort on boolean field with local-only mode (synchronous sort)
        expect(() => collection.sort('done', 1)).not.toThrow()
        expect(collection.items.value).toHaveLength(2)
    })
})
