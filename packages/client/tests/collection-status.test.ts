/**
 * `collection.status`: 'idle' until a query is asked for, 'loading' until something answers it,
 * then 'ready' — whether the answer came from the server, the cache or the device, empty or not.
 */

import { describe, expect, test } from 'bun:test'
import { Observable, of, Subject } from 'rxjs'
import { LivequeryClient } from '../src/LivequeryClient.js'
import { LivequeryCollection } from '../src/LivequeryCollection.js'
import { LivequeryMemoryStorage } from '../src/LivequeryMemoryStorage.js'
import type { Doc, LivequeryQueryResult, LivequeryTransporter } from '../src/index.js'

// initialize() guards on window — expose it for tests
// @ts-ignore
global.window = {}

type Todo = Doc<{ title: string, updated_at?: number }>

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

async function waitUntil(check: () => boolean, ms = 2000) {
    const started = Date.now()
    while (!check()) {
        if (Date.now() - started > ms) throw new Error('timed out')
        await tick(5)
    }
}

const answer = (items: Todo[]): Partial<LivequeryQueryResult> => ({
    changes: items.map(data => ({ collection_ref: 'todos', id: data.id, type: 'added' as const, data })),
    paging: { total: items.length, current: items.length },
    source: 'query',
})

function makeTransporter(query: LivequeryTransporter['query']): LivequeryTransporter {
    return {
        query,
        read: async () => answer([]),
        add: async (_ref, doc) => doc as any,
        update: async (_ref, id, patch) => ({ id, ...patch }) as any,
        delete: async (_ref, id) => ({ id }) as any,
        trigger: async () => ({}) as any,
    }
}

const makeClient = (transporter: LivequeryTransporter, storage = new LivequeryMemoryStorage()) =>
    new LivequeryClient({ storage, transporters: { rest: transporter } })

describe('collection.status', () => {
    test('server-first: idle → loading → ready', async () => {
        const server = new Subject<Partial<LivequeryQueryResult>>()
        const collection = new LivequeryCollection<Todo>(makeClient(makeTransporter(() => server)))
        expect(collection.status.value).toBe('idle')
        const linker = collection.initialize('todos')
        await waitUntil(() => collection.status.value === 'loading')
        server.next(answer([{ id: 'a', title: 'A' }]))
        await waitUntil(() => collection.status.value === 'ready')
        expect(collection.items.value).toHaveLength(1)
        linker?.unsubscribe()
    })

    test('an empty answer is ready too', async () => {
        const collection = new LivequeryCollection<Todo>(makeClient(makeTransporter(() => of(answer([])))))
        const linker = collection.initialize('todos')
        await waitUntil(() => collection.status.value === 'ready')
        expect(collection.items.value).toHaveLength(0)
        linker?.unsubscribe()
    })

    test('a document the client already holds is ready without a server query', async () => {
        let queries = 0
        const client = makeClient(makeTransporter(params => {
            queries++
            return of(answer([{ id: 'a', title: 'A' }]))
        }))
        const list = new LivequeryCollection<Todo>(client)
        const listLinker = list.initialize('todos')
        await waitUntil(() => list.status.value === 'ready')

        const doc = new LivequeryCollection<Todo>(client)
        const docLinker = doc.initialize('todos/a')
        await waitUntil(() => doc.status.value === 'ready')
        expect(doc.items.value[0]?.value.title).toBe('A')
        expect(doc.loading.value).toBeNull()
        expect(queries).toBe(1)
        listLinker?.unsubscribe()
        docLinker?.unsubscribe()
    })

    test('a failed query is error, and a new ref starts over at idle', async () => {
        const collection = new LivequeryCollection<Todo>(makeClient(makeTransporter(() => of({
            error: { code: 'FORBIDDEN', message: 'no' }, source: 'query' as const,
        }))))
        collection.initialize('todos')
        await waitUntil(() => collection.status.value === 'error')
        collection.initialize('todos/x/undefined')
        expect(collection.status.value).toBe('idle')
    })

    test('a lazy collection stays idle until queried', async () => {
        const collection = new LivequeryCollection<Todo>(makeClient(makeTransporter(() => of(answer([])))), { lazy: true })
        const linker = collection.initialize('todos')
        await tick()
        expect(collection.status.value).toBe('idle')
        await collection.query({})
        await waitUntil(() => collection.status.value === 'ready')
        linker?.unsubscribe()
    })

    test('local-first: an empty device is not ready until the first sync answers', async () => {
        let release!: () => void
        const gate = new Promise<void>(resolve => release = resolve)
        const transporter = makeTransporter(() => new Observable(() => undefined))
        transporter.read = async () => {
            await gate
            return { ...answer([{ id: 'a', title: 'A', updated_at: 1 }]), sync: true }
        }
        const collection = new LivequeryCollection<Todo>(makeClient(transporter), { mode: 'local-first' })
        const linker = collection.initialize('todos')
        await tick(50)
        expect(collection.status.value).toBe('loading')
        release()
        await waitUntil(() => collection.status.value === 'ready')
        expect(collection.items.value).toHaveLength(1)
        linker?.unsubscribe()
    })

    test('local-first: an empty scope the device already holds is ready', async () => {
        const storage = new LivequeryMemoryStorage()
        const transporter = makeTransporter(() => new Observable(() => undefined))
        const first = new LivequeryCollection<Todo>(makeClient(transporter, storage), { mode: 'local-first' })
        first.initialize('todos')
        await waitUntil(() => first.status.value === 'ready')

        const again = new LivequeryCollection<Todo>(makeClient(transporter, storage), { mode: 'local-first' })
        const linker = again.initialize('todos')
        await waitUntil(() => again.status.value === 'ready')
        expect(again.items.value).toHaveLength(0)
        linker?.unsubscribe()
    })
})
