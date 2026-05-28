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
