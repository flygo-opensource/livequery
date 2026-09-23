import { describe, expect, test } from 'bun:test'
import { BehaviorSubject, Observable, Subject } from 'rxjs'
import { LivequeryClient } from '../src/LivequeryClient.js'
import { LivequeryCollection } from '../src/LivequeryCollection.js'
import { LivequeryMemoryStorage } from '../src/LivequeryMemoryStorage.js'
import type { DataChangeEvent, Doc, LivequeryQueryResult, LivequeryTransporter } from '../src/index.js'

type Todo = Doc<{ title: string, done?: boolean }>

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

async function waitUntil(check: () => boolean | Promise<boolean>, ms = 2000) {
    const started = Date.now()
    while (!(await check())) {
        if (Date.now() - started > ms) throw new Error('timed out')
        await tick(10)
    }
}

/**
 * Mirrors RestTransporter: a first-page read with filters also opens a realtime stream that stays
 * open; a paged read, or a read without filters, answers once and completes.
 */
function makeServer(initial: Todo[]) {
    const docs = new Map(initial.map(d => [d.id, d]))
    const realtime$ = new Subject<DataChangeEvent>()
    const status$ = new BehaviorSubject({ connected: false })
    const stats = { reads: 0, live: 0 }
    const transporter: LivequeryTransporter = {
        query: ({ filters }) => new Observable<Partial<LivequeryQueryResult>>(subscriber => {
            stats.reads++
            const paged = !!filters?.[':after']
            const items = paged ? [{ id: 'page-2', title: 'page 2' }] : [...docs.values()]
            subscriber.next({
                changes: items.map(data => ({ collection_ref: 'todos', id: data.id, type: 'added', data })),
                paging: { total: items.length, current: items.length, ...!paged && filters?.[':limit'] ? { next: { count: 1, cursor: 'c1' } } : {} },
                source: 'query',
            })
            if (!filters || paged) return subscriber.complete()
            stats.live++
            const sub = realtime$.subscribe(change => subscriber.next({ changes: [change], source: 'realtime' }))
            return () => {
                stats.live--
                sub.unsubscribe()
            }
        }),
        add: async (_ref, doc) => ({ id: 'x', ...doc }) as any,
        update: async (_ref, id, doc) => ({ id, ...doc }) as any,
        delete: async (_ref, id) => ({ id }) as any,
        trigger: async () => ({}) as any,
        status$,
    }
    const reconnect = () => {
        status$.next({ connected: false })
        status$.next({ connected: true })
    }
    return { transporter, docs, realtime$, status$, stats, reconnect }
}

const titles = (col: LivequeryCollection<Todo>) => col.items.value.map(d => d.value.title).sort()

describe('refetch on reconnect — server-first', () => {
    test('changes missed while disconnected show up after the reconnect', async () => {
        const server = makeServer([{ id: '1', title: 'one' }, { id: '2', title: 'two' }])
        server.status$.next({ connected: true })
        const client = new LivequeryClient({ storage: new LivequeryMemoryStorage(), transporters: { t: server.transporter } })
        const col = new LivequeryCollection<Todo>(client, { ssr: false, mode: 'server-first' })
        col.initialize('todos')
        await waitUntil(() => col.items.value.length === 2)
        const loading: any[] = []
        col.loading.subscribe(l => loading.push(l))

        // While the socket is down: one edit, one delete, one insert — none of them delivered.
        server.docs.set('1', { id: '1', title: 'one-edited' })
        server.docs.delete('2')
        server.docs.set('3', { id: '3', title: 'three' })
        server.reconnect()

        await waitUntil(() => titles(col).join() === 'one-edited,three')
        expect(loading).not.toContain('all')
        client.destroy()
    })

    test('after many reconnects there is still exactly one live stream', async () => {
        const server = makeServer([{ id: '1', title: 'one' }])
        server.status$.next({ connected: true })
        const client = new LivequeryClient({ storage: new LivequeryMemoryStorage(), transporters: { t: server.transporter } })
        const col = new LivequeryCollection<Todo>(client, { ssr: false, mode: 'server-first', filters: { 'title:sort': 'asc' } as any })
        col.initialize('todos')
        await waitUntil(() => col.items.value.length === 1)
        expect(server.stats.live).toBe(1)

        for (let i = 0; i < 5; i++) {
            server.reconnect()
            await tick()
        }
        expect(server.stats.live).toBe(1)

        // and realtime is delivered once, not once per reconnect
        const seen: number[] = []
        col.items.subscribe(items => seen.push(items.length))
        server.realtime$.next({ collection_ref: 'todos', id: '9', type: 'added', data: { id: '9', title: 'nine' } })
        await waitUntil(() => col.items.value.length === 2)
        await tick()
        expect(col.items.value.filter(d => d.value.id === '9')).toHaveLength(1)
        client.destroy()
    })

    test('the first connection does not refetch', async () => {
        const server = makeServer([{ id: '1', title: 'one' }])
        const client = new LivequeryClient({ storage: new LivequeryMemoryStorage(), transporters: { t: server.transporter } })
        const col = new LivequeryCollection<Todo>(client, { ssr: false, mode: 'server-first', filters: {} })
        col.initialize('todos')
        await waitUntil(() => col.items.value.length === 1)
        server.status$.next({ connected: true })
        await tick()
        expect(server.stats.reads).toBe(1)
        client.destroy()
    })

    test('a new query replaces the previous live stream; loadMore does not', async () => {
        const server = makeServer([{ id: '1', title: 'one' }])
        server.status$.next({ connected: true })
        const client = new LivequeryClient({ storage: new LivequeryMemoryStorage(), transporters: { t: server.transporter } })
        const col = new LivequeryCollection<Todo>(client, { ssr: false, mode: 'server-first', filters: { ':limit': 1 } as any })
        col.initialize('todos')
        await waitUntil(() => col.items.value.length === 1)
        expect(server.stats.live).toBe(1)

        await col.loadMore()
        await waitUntil(() => col.items.value.length === 2)
        expect(server.stats.live).toBe(1)

        await col.query({ 'title:sort': 'desc' } as any)
        await tick(50)
        expect(server.stats.live).toBe(1)
        client.destroy()
    })
})

describe('refetch on reconnect — local-first', () => {
    test('storage and collection catch up; unsynced local documents are kept', async () => {
        const server = makeServer([{ id: '1', title: 'one' }, { id: '2', title: 'two' }])
        server.status$.next({ connected: true })
        const storage = new LivequeryMemoryStorage()
        const client = new LivequeryClient({ storage, transporters: { t: server.transporter } })
        const col = new LivequeryCollection<Todo>(client, { ssr: false, mode: 'local-first' })
        col.initialize('todos')
        await waitUntil(() => col.items.value.length === 2)
        await col.add({ title: 'draft' }, 'local-only')
        const live_before = server.stats.live

        server.docs.set('1', { id: '1', title: 'one-edited' })
        server.docs.delete('2')
        server.docs.set('3', { id: '3', title: 'three' })
        server.reconnect()

        await waitUntil(() => titles(col).join() === 'draft,one-edited,three')
        expect(await storage.get('todos', '2')).toBeNull()
        expect(await storage.get('todos', '1')).toMatchObject({ title: 'one-edited' })
        // The one-shot read closes; the long-lived sync is the only stream left.
        expect(server.stats.live).toBe(live_before)
        client.destroy()
    })

    test('a failed refetch removes nothing', async () => {
        const server = makeServer([{ id: '1', title: 'one' }])
        server.status$.next({ connected: true })
        const storage = new LivequeryMemoryStorage()
        const client = new LivequeryClient({ storage, transporters: { t: server.transporter } })
        const col = new LivequeryCollection<Todo>(client, { ssr: false, mode: 'local-first' })
        col.initialize('todos')
        await waitUntil(() => col.items.value.length === 1)

        const query = server.transporter.query
        server.transporter.query = () => new Observable(s => s.next({ error: { code: 'NETWORK_ERROR', message: 'x' }, source: 'query' }))
        server.reconnect()
        await tick(50)
        expect(titles(col)).toEqual(['one'])
        expect(await storage.get('todos', '1')).not.toBeNull()
        server.transporter.query = query
        client.destroy()
    })
})
