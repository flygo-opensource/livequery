import { describe, expect, test } from 'bun:test'
import { BehaviorSubject, Observable, Subject } from 'rxjs'
// The worker transport the demos use; imported from source so the client has no dependency on it.
import { RpcChannel, type RpcMessage } from '../../rpc/src/RpcChannel.js'
import { ServiceLinker } from '../../rpc/src/ServiceLinker.js'
import { WorkerManager } from '../../rpc/src/WorkerManager.js'
import { LivequeryClient, LIVEQUERY_STATUS_REF } from '../src/LivequeryClient.js'
import { LivequeryCollection } from '../src/LivequeryCollection.js'
import { LivequeryMemoryStorage } from '../src/LivequeryMemoryStorage.js'
import { createRemoteLivequeryClient } from '../src/createRemoteLivequeryClient.js'
import type { DataChangeEvent, Doc, LivequeryQueryResult, LivequeryTransporter } from '../src/index.js'

type Todo = Doc<{ title: string }>

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

async function waitUntil(check: () => boolean | Promise<boolean>, ms = 2000) {
    const started = Date.now()
    while (!(await check())) {
        if (Date.now() - started > ms) throw new Error('timed out')
        await tick(10)
    }
}

// postMessage copies: structuredClone keeps the test honest about what crosses the boundary.
class MemoryChannel extends RpcChannel {
    peer?: MemoryChannel
    send(message: RpcMessage): void {
        const copy = structuredClone(message)
        queueMicrotask(() => this.peer?.next({
            ...copy,
            respond: response => {
                const answer = structuredClone(response)
                queueMicrotask(() => this.next({ id: copy.id, response: answer, respond: () => undefined }))
            },
        }))
    }
}

function makeServer() {
    const docs = new Map<string, Todo>([['1', { id: '1', title: 'one' }]])
    const realtime$ = new Subject<DataChangeEvent>()
    const stats = { live: 0, adds: 0 }
    const transporter: LivequeryTransporter = {
        query: () => new Observable<Partial<LivequeryQueryResult>>(subscriber => {
            subscriber.next({
                changes: [...docs.values()].map(data => ({ collection_ref: 'todos', id: data.id, type: 'added', data })),
                paging: { total: docs.size, current: docs.size },
                source: 'query',
            })
            stats.live++
            const sub = realtime$.subscribe(change => subscriber.next({ changes: [change], source: 'realtime' }))
            return () => {
                stats.live--
                sub.unsubscribe()
            }
        }),
        add: async (_ref, doc: any) => {
            stats.adds++
            const saved = { ...doc, id: doc.id ?? `s${stats.adds}` }
            docs.set(saved.id, saved)
            // Like a real server: the write comes back on the realtime stream too.
            queueMicrotask(() => realtime$.next({ collection_ref: 'todos', id: saved.id, type: 'added', data: saved }))
            return saved
        },
        update: async (_ref, id, doc) => ({ id, ...doc }) as any,
        delete: async (_ref, id) => ({ id }) as any,
        trigger: async action => ({ echoed: action.action }) as any,
        status$: new BehaviorSubject({ connected: true }),
    }
    return { transporter, docs, realtime$, stats }
}

function connect() {
    const server = makeServer()
    const worker_client = new LivequeryClient({ storage: new LivequeryMemoryStorage(), transporters: { t: server.transporter } })
    const tab_channel = new MemoryChannel()
    const worker_channel = new MemoryChannel()
    tab_channel.peer = worker_channel
    worker_channel.peer = tab_channel
    new WorkerManager(worker_channel).exposeService('livequery', worker_client)
    const client = createRemoteLivequeryClient(new ServiceLinker(tab_channel).linkService<any>('livequery'))
    return { server, worker_client, client }
}

describe('remote client over @livequery/rpc', () => {
    test('a tab collection reads, receives realtime and writes through the worker', async () => {
        const { server, worker_client, client } = connect()
        const todos = new LivequeryCollection<Todo>(client, { ssr: false })
        const linker = todos.initialize('todos')
        await waitUntil(() => todos.items.value.length === 1)

        server.realtime$.next({ collection_ref: 'todos', id: '2', type: 'added', data: { id: '2', title: 'two' } })
        await waitUntil(() => todos.items.value.length === 2)

        const added = await todos.add({ title: 'three' })
        expect(added.title).toBe('three')
        await waitUntil(() => todos.items.value.some(d => d.value.title === 'three'))
        expect(server.stats.adds).toBe(1)

        expect(await todos.trigger('ping')).toEqual({ echoed: 'ping' } as any)

        // Unmounting in the tab releases the stream in the worker.
        linker?.unsubscribe()
        await waitUntil(() => server.stats.live === 0)
        worker_client.destroy()
    })

    test('local-first writes and the status document work across the boundary', async () => {
        const { server, worker_client, client } = connect()
        const status = new LivequeryCollection<any>(client, { ssr: false })
        status.initialize(LIVEQUERY_STATUS_REF)
        const todos = new LivequeryCollection<Todo>(client, { ssr: false, mode: 'local-first' })
        todos.initialize('todos')
        await waitUntil(() => status.items.value[0]?.value.connected === true && todos.items.value.length === 1)

        await status.update({ id: 'status', offline: true } as any)
        await waitUntil(() => status.items.value[0]?.value.offline === true)
        await todos.add({ title: 'offline' })
        await waitUntil(() => status.items.value[0]?.value.pending === 1)
        expect(server.stats.adds).toBe(0)
        expect(todos.items.value.map(d => d.value.title).sort()).toEqual(['offline', 'one'])

        await status.update({ id: 'status', offline: false } as any)
        await waitUntil(() => server.stats.adds === 1 && status.items.value[0]?.value.pending === 0)
        worker_client.destroy()
    })

    test('errors keep their code', async () => {
        const { server, worker_client, client } = connect()
        server.transporter.add = async () => { throw { code: 'FORBIDDEN', message: 'no' } }
        const todos = new LivequeryCollection<Todo>(client, { ssr: false })
        todos.initialize('todos')
        await waitUntil(() => todos.items.value.length === 1)
        const error = await todos.add({ title: 'x' }).then(() => null, e => e)
        expect(error?.code).toBe('FORBIDDEN')
        worker_client.destroy()
    })
})
