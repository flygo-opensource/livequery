/**
 * Two devices edit the same document; one of them was offline. The server refuses a write based
 * on a version it no longer has (409 VERSION_CONFLICT), so the late device resolves the conflict
 * — through `conflictResolver` when there is one — instead of silently overwriting.
 */
import { describe, expect, test } from 'bun:test'
import { BehaviorSubject, Observable, Subject } from 'rxjs'
import { LivequeryClient, type ConflictResolverFunction } from '../src/LivequeryClient.js'
import { LivequeryCollection } from '../src/LivequeryCollection.js'
import { LivequeryMemoryStorage } from '../src/LivequeryMemoryStorage.js'
import type { DataChangeEvent, Doc, LivequeryQueryParams, LivequeryQueryResult, LivequeryTransporter } from '../src/index.js'

type Todo = Doc<{ title: string, done: boolean, updated_at?: number }>

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

async function waitUntil(check: () => boolean | Promise<boolean>, ms = 3000) {
    const started = Date.now()
    while (!(await check())) {
        if (Date.now() - started > ms) throw new Error('timed out')
        await tick(10)
    }
}

// A versioned server with conditional updates, one realtime channel.
function makeServer() {
    const docs = new Map<string, Todo & { updated_at: number }>()
    const realtime$ = new Subject<DataChangeEvent>()
    const state = { clock: 100, conflicts: 0, updates: [] as Array<{ id: string, fields: Record<string, any>, if_version?: number }> }
    const put = (doc: Todo) => {
        const stored = { ...doc, updated_at: ++state.clock }
        docs.set(doc.id, stored)
        realtime$.next({ collection_ref: 'todos', id: doc.id, type: 'modified', data: { ...stored } })
        return stored
    }
    const read = ({ ref }: LivequeryQueryParams<any>): Partial<LivequeryQueryResult> => {
        const [, id] = ref.split('/')
        const list = id ? [docs.get(id)].filter(Boolean) as Todo[] : [...docs.values()]
        return { changes: list.map(data => ({ collection_ref: 'todos', id: data.id, type: 'added', data: { ...data } })), paging: { total: list.length, current: list.length }, source: 'query' }
    }
    // Each device has its own connection, which can be cut.
    // `read_delay`: this device's reads lag, so its push goes out before its catch-up.
    const transporter = (read_delay = 0) => {
        const status$ = new BehaviorSubject({ connected: true })
        const t: LivequeryTransporter & { status$: BehaviorSubject<{ connected: boolean }> } = {
            status$,
            read: async params => {
                await tick(read_delay)
                if (!status$.value.connected) return { error: { code: 'NETWORK_ERROR', message: 'offline' }, source: 'query' }
                return read(params)
            },
            query: params => new Observable(subscriber => {
                const first = setTimeout(() => subscriber.next(read(params)), read_delay)
                const sub = realtime$.subscribe(change => status$.value.connected && subscriber.next({ changes: [change], source: 'realtime' }))
                return () => {
                    clearTimeout(first)
                    sub.unsubscribe()
                }
            }),
            add: async (_ref, doc: any) => put(doc) as any,
            update: async (_ref, id, fields: any, _context, options) => {
                if (!status$.value.connected) throw { code: 'NETWORK_ERROR', message: 'offline' }
                state.updates.push({ id, fields, if_version: options?.if_version })
                const current = docs.get(id)!
                if (options?.if_version !== undefined && current.updated_at !== options.if_version) {
                    state.conflicts++
                    throw { status: 409, code: 'VERSION_CONFLICT', message: 'changed' }
                }
                return { item: put({ ...current, ...fields }) } as any
            },
            delete: async (_ref, id) => ({ id }) as any,
            trigger: async () => ({}) as any,
        }
        return t
    }
    return { docs, state, put, transporter }
}

function device(server: ReturnType<typeof makeServer>, conflictResolver?: ConflictResolverFunction, read_delay = 0) {
    const transporter = server.transporter(read_delay)
    const client = new LivequeryClient({ storage: new LivequeryMemoryStorage(), transporters: { t: transporter }, conflictResolver, syncOverlap: 0 })
    const todos = new LivequeryCollection<Todo>(client, { ssr: false, mode: { scope: 'full' } })
    todos.initialize('todos')
    const value = () => todos.items.value[0]?.value
    return { client, todos, value, transporter, offline: () => transporter.status$.next({ connected: false }), online: () => transporter.status$.next({ connected: true }) }
}

describe('write conflicts are detected by the server', () => {
    test('same field: the late device does not overwrite silently — default keeps its own edit, on purpose', async () => {
        const server = makeServer()
        server.put({ id: '1', title: 'original', done: false })
        // A's push goes out before its catch-up read: only the server can see the conflict.
        const a = device(server, undefined, 300)
        const b = device(server)
        await waitUntil(() => a.value()?.title === 'original' && b.value()?.title === 'original')

        a.offline()
        await a.todos.update({ id: '1', title: 'from A (offline)' })
        await b.todos.update({ id: '1', title: 'from B' })
        await waitUntil(() => server.docs.get('1')!.title === 'from B')

        a.online()
        await waitUntil(() => server.docs.get('1')!.title === 'from A (offline)')
        // A's write was based on the old version: refused once, then resent on top of B's.
        const from_a = server.state.updates.filter(u => u.fields.title === 'from A (offline)')
        expect(server.state.conflicts).toBeGreaterThanOrEqual(1)
        expect(from_a.at(-1)!.if_version).toBe(server.docs.get('1')!.updated_at - 1)
        a.client.destroy()
        b.client.destroy()
    })

    test('same field: a conflictResolver that keeps the server copy — A sends nothing, both devices show B', async () => {
        const server = makeServer()
        server.put({ id: '1', title: 'original', done: false })
        const seen: Array<{ local: string, remote: string }> = []
        const serverWins: ConflictResolverFunction = ({ old_document, change }) => {
            seen.push({ local: (old_document as any).title, remote: change.data!.title })
            return { approved: true, document: { ...change.data, _prev: undefined, _updating: undefined } as any }
        }
        const a = device(server, serverWins)
        const b = device(server)
        await waitUntil(() => a.value()?.title === 'original' && b.value()?.title === 'original')

        a.offline()
        await a.todos.update({ id: '1', title: 'from A (offline)' })
        await b.todos.update({ id: '1', title: 'from B' })
        await waitUntil(() => server.docs.get('1')!.title === 'from B')

        a.online()
        await waitUntil(() => a.value()?.title === 'from B' && !a.value()?._prev)
        await tick(200)
        expect(server.docs.get('1')!.title).toBe('from B')
        expect(seen).toContainEqual({ local: 'from A (offline)', remote: 'from B' })
        a.client.destroy()
        b.client.destroy()
    })

    test('different fields: both edits survive', async () => {
        const server = makeServer()
        server.put({ id: '1', title: 'original', done: false })
        const a = device(server)
        const b = device(server)
        await waitUntil(() => a.value()?.title === 'original' && b.value()?.title === 'original')

        a.offline()
        await a.todos.update({ id: '1', title: 'renamed by A' })
        await b.todos.update({ id: '1', done: true })
        await waitUntil(() => server.docs.get('1')!.done === true)

        a.online()
        await waitUntil(() => server.docs.get('1')!.title === 'renamed by A')
        expect(server.docs.get('1')).toMatchObject({ title: 'renamed by A', done: true })
        await waitUntil(() => a.value()?.done === true && b.value()?.title === 'renamed by A')
        a.client.destroy()
        b.client.destroy()
    })

    test('edits one after another on one device never conflict with themselves', async () => {
        const server = makeServer()
        server.put({ id: '1', title: 'original', done: false })
        const a = device(server)
        await waitUntil(() => a.value()?.title === 'original')
        for (let i = 1; i <= 5; i++) await a.todos.update({ id: '1', title: `edit ${i}` })
        await waitUntil(() => server.docs.get('1')!.title === 'edit 5')
        expect(server.state.conflicts).toBe(0)
        a.client.destroy()
    })
})
