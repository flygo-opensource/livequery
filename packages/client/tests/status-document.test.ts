import { describe, expect, test } from 'bun:test'
import { BehaviorSubject, Observable } from 'rxjs'
import { LivequeryClient, LIVEQUERY_STATUS_REF, type LivequeryStatus } from '../src/LivequeryClient.js'
import { LivequeryCollection } from '../src/LivequeryCollection.js'
import { LivequeryMemoryStorage } from '../src/LivequeryMemoryStorage.js'
import type { Doc, LivequeryQueryResult, LivequeryTransporter } from '../src/index.js'

type Todo = Doc<{ title: string }>

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

async function waitUntil(check: () => boolean | Promise<boolean>, ms = 2000) {
    const started = Date.now()
    while (!(await check())) {
        if (Date.now() - started > ms) throw new Error('timed out')
        await tick(10)
    }
}

function makeServer() {
    const docs = new Map<string, Todo>()
    const status$ = new BehaviorSubject({ connected: true })
    const stats = { adds: 0, reads: 0 }
    const transporter: LivequeryTransporter = {
        query: () => new Observable<Partial<LivequeryQueryResult>>(subscriber => {
            stats.reads++
            subscriber.next({
                changes: [...docs.values()].map(data => ({ collection_ref: 'todos', id: data.id, type: 'added', data })),
                paging: { total: docs.size, current: docs.size },
                source: 'query',
            })
        }),
        add: async (_ref, doc: any) => {
            stats.adds++
            const saved = { ...doc, id: doc.id ?? `s${stats.adds}` }
            docs.set(saved.id, saved)
            return saved
        },
        update: async (_ref, id, doc) => ({ id, ...doc }) as any,
        delete: async (_ref, id) => ({ id }) as any,
        trigger: async () => ({}) as any,
        status$,
    }
    return { transporter, docs, status$, stats }
}

const statusOf = (col: LivequeryCollection<any>) => col.items.value[0]?.value as unknown as LivequeryStatus | undefined

describe('livequery/status document', () => {
    test('is served without a server and follows the connection', async () => {
        const server = makeServer()
        const client = new LivequeryClient({ storage: new LivequeryMemoryStorage(), transporters: { t: server.transporter } })
        const status = new LivequeryCollection<any>(client, { ssr: false })
        status.initialize(LIVEQUERY_STATUS_REF)
        await waitUntil(() => statusOf(status)?.connected === true)
        expect(statusOf(status)).toMatchObject({ id: 'status', connected: true, offline: false, online: true, pending: 0 })

        server.status$.next({ connected: false })
        await waitUntil(() => statusOf(status)?.connected === false)
        expect(statusOf(status)?.online).toBe(false)
        client.destroy()
    })

    test('updating it with { offline: true } holds writes until it is switched back', async () => {
        const server = makeServer()
        const client = new LivequeryClient({ storage: new LivequeryMemoryStorage(), transporters: { t: server.transporter } })
        const status = new LivequeryCollection<any>(client, { ssr: false })
        status.initialize(LIVEQUERY_STATUS_REF)
        const todos = new LivequeryCollection<Todo>(client, { ssr: false, mode: 'local-first' })
        todos.initialize('todos')
        await waitUntil(() => statusOf(status)?.connected === true)

        await status.update({ id: 'status', offline: true } as any)
        await waitUntil(() => statusOf(status)?.offline === true)
        expect(statusOf(status)?.connected).toBe(false)

        todos.add({ title: 'written offline' })
        await waitUntil(() => statusOf(status)?.pending === 1)
        await tick(100)
        expect(server.stats.adds).toBe(0)
        expect(todos.items.value.map(d => d.value.title)).toEqual(['written offline'])

        await status.update({ id: 'status', offline: false } as any)
        await waitUntil(() => server.stats.adds === 1 && statusOf(status)?.pending === 0)
        expect(statusOf(status)).toMatchObject({ connected: true, offline: false, online: true })
        expect([...server.docs.values()].map(d => d.title)).toEqual(['written offline'])
        client.destroy()
    })

    test('local-first sync does not reach the server either while the switch is on', async () => {
        const server = makeServer()
        server.docs.set('1', { id: '1', title: 'one' })
        const reads = { count: 0 }
        server.transporter.read = async () => {
            reads.count++
            return { changes: [...server.docs.values()].map(data => ({ collection_ref: 'todos', id: data.id, type: 'added' as const, data })), paging: { total: 1, current: 1 }, source: 'query' as const }
        }
        const client = new LivequeryClient({ storage: new LivequeryMemoryStorage(), transporters: { t: server.transporter } })
        client.setOffline(true)
        const todos = new LivequeryCollection<Todo>(client, { ssr: false, mode: { scope: 'full' } })
        todos.initialize('todos')
        await tick(150)
        expect(reads.count + server.stats.reads).toBe(0)
        expect(todos.items.value).toHaveLength(0)

        client.setOffline(false)
        await waitUntil(() => todos.items.value.length === 1)
        client.destroy()
    })

    test('reads fail as offline while the switch is on', async () => {
        const server = makeServer()
        server.docs.set('1', { id: '1', title: 'one' })
        const client = new LivequeryClient({ storage: new LivequeryMemoryStorage(), transporters: { t: server.transporter } })
        client.setOffline(true)
        const todos = new LivequeryCollection<Todo>(client, { ssr: false, mode: 'server-first' })
        todos.initialize('todos')
        await waitUntil(() => todos.error.value?.code === 'NETWORK_ERROR')
        expect(server.stats.reads).toBe(0)

        client.setOffline(false)
        await waitUntil(() => todos.items.value.length === 1)
        client.destroy()
    })
})
