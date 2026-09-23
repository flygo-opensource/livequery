/**
 * A chat's message list: read page by page from the server (cache-first, newest first, older pages
 * with loadMore) while sends go through the outbox (local-first) — and `retry()` for a send the
 * server refused.
 */

import { describe, expect, test } from 'bun:test'
import { Observable, Subject } from 'rxjs'
import { LivequeryClient } from '../src/LivequeryClient.js'
import { LivequeryCollection } from '../src/LivequeryCollection.js'
import { LivequeryMemoryStorage } from '../src/LivequeryMemoryStorage.js'
import type { DataChangeEvent, Doc, DocState, LivequeryQueryResult, LivequeryTransporter } from '../src/index.js'

type Message = Doc<{ text: string, created_at: number }>

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

async function waitUntil(check: () => boolean | Promise<boolean>, ms = 2000) {
    const started = Date.now()
    while (!(await check())) {
        if (Date.now() - started > ms) throw new Error('timed out')
        await tick(10)
    }
}

const REF = 'chats/c1/messages'

/** 50 messages on the server; pages of 10, newest first; realtime for the first page. */
function makeServer() {
    const messages = new Map<string, Message>()
    for (let i = 1; i <= 50; i++) messages.set(`m${String(i).padStart(2, '0')}`, { id: `m${String(i).padStart(2, '0')}`, text: `#${i}`, created_at: i })
    const realtime$ = new Subject<DataChangeEvent>()
    const state = { online: true, reject: undefined as undefined | ((body: any) => any) }
    const sorted = () => [...messages.values()].sort((a, b) => b.created_at - a.created_at)
    const transporter: LivequeryTransporter = {
        query: ({ filters }) => new Observable<Partial<LivequeryQueryResult>>(subscriber => {
            if (!state.online) {
                subscriber.next({ error: { code: 'NETWORK_ERROR', message: 'offline' }, source: 'query' })
                return
            }
            const after = filters?.[':after'] as string | undefined
            const all = sorted()
            const start = after ? all.findIndex(m => m.id === after) + 1 : 0
            const page = all.slice(start, start + 10)
            const has_next = start + 10 < all.length
            subscriber.next({
                changes: page.map(data => ({ collection_ref: REF, id: data.id, type: 'added', data })),
                paging: { total: all.length, current: page.length, ...has_next ? { next: { count: all.length - start - 10, cursor: page.at(-1)!.id } } : {} },
                source: 'query',
            })
            if (after) return subscriber.complete()
            const sub = realtime$.subscribe(change => subscriber.next({ changes: [change], source: 'realtime' }))
            return () => sub.unsubscribe()
        }),
        add: async (_ref, body: any) => {
            if (!state.online) throw { code: 'NETWORK_ERROR', message: 'offline' }
            const refusal = state.reject?.(body)
            if (refusal) throw refusal
            const message = { ...body } as Message
            messages.set(message.id, message)
            // The change stream echoes every insert, ours included.
            setTimeout(() => realtime$.next({ collection_ref: REF, id: message.id, type: 'added', data: message }), 5)
            return message as any
        },
        update: async (_ref, id, body) => ({ id, ...body }) as any,
        delete: async (_ref, id) => {
            if (!state.online) throw { code: 'NETWORK_ERROR', message: 'offline' }
            messages.delete(id)
            return { id } as any
        },
        trigger: async () => ({}) as any,
    }
    return { transporter, messages, realtime$, state }
}

function makeChat(server = makeServer()) {
    const client = new LivequeryClient({ storage: new LivequeryMemoryStorage(), transporters: { rest: server.transporter } })
    const col = new LivequeryCollection<Message>(client, {
        ssr: false,
        mode: 'cache-first',
        filters: { ':limit': 10, 'created_at:sort': 'desc' } as any,
    })
    col.initialize(REF)
    return { client, col, server }
}

const ids = (col: LivequeryCollection<Message>) => col.items.value.map(d => d.value.id)
const byText = (col: LivequeryCollection<Message>, text: string) => col.items.value.filter(d => d.value.text === text).map(d => d.value)

describe('paged list, writes through the outbox', () => {
    test('a sent message shows at once, and the realtime echo of it does not duplicate it', async () => {
        const { client, col, server } = makeChat()
        await waitUntil(() => col.items.value.length === 10)
        let release!: () => void
        const gate = new Promise<void>(r => { release = r })
        const add = server.transporter.add
        server.transporter.add = async (...args) => {
            await gate
            return await add(...args)
        }

        const sending = col.add({ text: 'hello', created_at: 100 }, 'local-first')
        await tick()
        expect(byText(col, 'hello')).toHaveLength(1)
        expect(byText(col, 'hello')[0]!._adding).toBe(true)

        release()
        await sending
        await tick(50)
        expect(byText(col, 'hello')).toHaveLength(1)
        expect(byText(col, 'hello')[0]!._adding).toBeUndefined()
        client.destroy()
    })

    test('loading older pages while new messages arrive loses nothing and repeats nothing', async () => {
        const { client, col, server } = makeChat()
        await waitUntil(() => col.items.value.length === 10)

        const older = col.loadMore()
        server.realtime$.next({ collection_ref: REF, id: 'n1', type: 'added', data: { id: 'n1', text: 'live', created_at: 200 } })
        await older
        await waitUntil(() => col.items.value.length === 21)
        await col.loadMore()
        await waitUntil(() => col.items.value.length === 31)

        expect(new Set(ids(col)).size).toBe(31)
        expect(ids(col)).toContain('n1')
        expect(ids(col)).toContain('m21')
        client.destroy()
    })

    test('offline, a sent message waits in the paged list and goes out when back online', async () => {
        const { client, col, server } = makeChat()
        await waitUntil(() => col.items.value.length === 10)
        server.state.online = false

        const result = await col.add({ text: 'later', created_at: 101 }, 'local-first') as DocState<Message>
        expect(result._queued).toBe(true)
        expect(byText(col, 'later')[0]?._queued).toBe(true)

        server.state.online = true
        client.outbox.trigger()
        await waitUntil(() => server.messages.has(result.id))
        await waitUntil(() => byText(col, 'later')[0]?._queued === undefined)
        await tick(50)
        expect(byText(col, 'later')).toHaveLength(1)
        client.destroy()
    })
})

describe('retry()', () => {
    test('a refused send is retried with the same id once the cause is gone — one message, no error', async () => {
        const { client, col, server } = makeChat()
        await waitUntil(() => col.items.value.length === 10)
        server.state.reject = body => body.text.startsWith('/fail') ? { code: 'REJECTED', message: 'no', status: 422 } : undefined

        await col.add({ text: '/fail please', created_at: 102 }, 'local-first')
        const failed = byText(col, '/fail please')[0]!
        expect(failed._adding_error?.code).toBe('REJECTED')
        expect(await client.outbox.pending()).toEqual([])

        // Still refused: the error comes back.
        await col.retry(failed.id)
        expect(byText(col, '/fail please')[0]!._adding_error?.code).toBe('REJECTED')

        server.state.reject = undefined
        await col.retry(failed.id)
        await waitUntil(() => server.messages.has(failed.id))
        const sent = byText(col, '/fail please')
        expect(sent).toHaveLength(1)
        expect(sent[0]!.id).toBe(failed.id)
        expect(sent[0]!._adding_error).toBeUndefined()
        expect(sent[0]!._adding).toBeUndefined()
        client.destroy()
    })

    test('a refused delete is retried', async () => {
        const { client, col, server } = makeChat()
        await waitUntil(() => col.items.value.length === 10)
        const del = server.transporter.delete
        server.transporter.delete = async () => { throw { code: 'FORBIDDEN', message: 'no', status: 403 } }

        await col.delete('m50', 'local-first')
        expect(col.items.value.find(d => d.value.id === 'm50')?.value._deleting_error?.code).toBe('FORBIDDEN')

        server.transporter.delete = del
        await col.retry('m50')
        await waitUntil(() => !server.messages.has('m50'))
        await waitUntil(() => !ids(col).includes('m50'))
        client.destroy()
    })

    test('retry of a document without an error does nothing', async () => {
        const { client, col } = makeChat()
        await waitUntil(() => col.items.value.length === 10)
        expect(await col.retry('m50')).toEqual([])
        client.destroy()
    })
})
