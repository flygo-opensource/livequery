/**
 * Local-first criteria not covered elsewhere: the app works from a cold start with no network, a
 * write shows before the server answers, an expired login parks writes instead of losing them, the
 * UI can show how many writes are waiting, and a queue that cannot be written says so.
 */

import { describe, expect, test } from 'bun:test'
import { NEVER, Observable } from 'rxjs'
import { LivequeryClient } from '../src/LivequeryClient.js'
import { LivequeryCollection } from '../src/LivequeryCollection.js'
import { LivequeryMemoryStorage } from '../src/LivequeryMemoryStorage.js'
import { LIVEQUERY_OUTBOX_REF, type OutboxEntry } from '../src/LivequeryOutbox.js'
import type { Doc, DocState, LivequeryTransporter } from '../src/index.js'

type Todo = Doc<{ title: string, done?: boolean }>

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

async function waitUntil(check: () => boolean | Promise<boolean>, ms = 2000) {
    const started = Date.now()
    while (!(await check())) {
        if (Date.now() - started > ms) throw new Error('timed out')
        await tick(10)
    }
}

function makeTransporter(fail: () => { code: string, message: string, status?: number } | undefined) {
    const sent: Array<Record<string, any>> = []
    let next_id = 1
    const transporter: LivequeryTransporter = {
        query: () => NEVER,
        add: async (_ref, body) => {
            const error = fail()
            if (error) throw error
            sent.push(body)
            return { ...body, id: `srv-${next_id++}` } as any
        },
        update: async (_ref, id, body) => ({ id, ...body }) as any,
        delete: async (_ref, id) => ({ id }) as any,
        trigger: async () => ({}) as any,
    }
    return { transporter, sent }
}

describe('network optional', () => {
    test('cold start offline — documents from the last session show, the failed sync does not wipe them', async () => {
        const storage = new LivequeryMemoryStorage()
        await storage.add('todos', { id: 'srv-1', title: 'saved yesterday' } as any)
        await storage.add('todos', { id: 'local:1', title: 'drafted offline', _adding: true } as any)

        const offline: LivequeryTransporter = {
            query: () => new Observable(s => s.next({ error: { code: 'NETWORK_ERROR', message: 'offline' }, source: 'query' })),
            add: async () => { throw { code: 'NETWORK_ERROR', message: 'offline' } },
            update: async () => { throw { code: 'NETWORK_ERROR', message: 'offline' } },
            delete: async () => { throw { code: 'NETWORK_ERROR', message: 'offline' } },
            trigger: async () => { throw { code: 'NETWORK_ERROR', message: 'offline' } },
        }
        const client = new LivequeryClient({ storage, transporters: { rest: offline } })
        const col = new LivequeryCollection<Todo>(client, { ssr: false, mode: 'local-first' })
        col.initialize('todos')

        await waitUntil(() => col.items.value.length === 2)
        await tick(50)
        expect(col.items.value.map(d => d.value.title).sort()).toEqual(['drafted offline', 'saved yesterday'])
        expect(col.loading.value).toBeNull()

        // and it keeps working: a new offline write lands next to them
        await col.add({ title: 'written offline' })
        expect(col.items.value).toHaveLength(3)
        client.destroy()
    })

    test('no spinners — a local-first write is on screen before the server answers', async () => {
        let release!: () => void
        const gate = new Promise<void>(r => { release = r })
        const { transporter } = makeTransporter(() => undefined)
        const add = transporter.add
        transporter.add = async (...args) => {
            await gate
            return await add(...args)
        }
        const client = new LivequeryClient({ storage: new LivequeryMemoryStorage(), transporters: { rest: transporter } })
        const col = new LivequeryCollection<Todo>(client, { ssr: false, mode: 'local-first' })
        col.initialize('todos')
        await tick()

        const pending = col.add({ title: 'instant' })
        await tick()
        expect(col.items.value.map(d => d.value.title)).toEqual(['instant'])
        expect(col.items.value[0]!.value._adding).toBe(true)

        release()
        await pending
        client.destroy()
    })
})

describe('writes are never lost to an expired login', () => {
    test('401 parks the queue; after the token is refreshed the same write goes through', async () => {
        let token_valid = false
        const { transporter, sent } = makeTransporter(() => token_valid ? undefined : { code: 'UNAUTHORIZED', message: 'expired', status: 401 })
        const client = new LivequeryClient({ storage: new LivequeryMemoryStorage(), transporters: { rest: transporter } })
        const col = new LivequeryCollection<Todo>(client, { ssr: false, mode: 'local-first' })
        col.initialize('todos')
        await tick()

        const result = await col.add({ title: 'written before re-login' }) as DocState<Todo>
        expect(result._queued).toBe(true)
        expect(result._adding_error).toBeUndefined()
        expect(await client.outbox.pending()).toHaveLength(1)

        token_valid = true
        client.outbox.trigger()
        await waitUntil(() => sent.length === 1)
        expect(sent[0]).toEqual({ title: 'written before re-login', id: result.id })
        await waitUntil(async () => (await client.outbox.pending()).length === 0)
        client.destroy()
    })

    test('403 is final — not retried, the error lands on the document', async () => {
        const { transporter } = makeTransporter(() => ({ code: 'FORBIDDEN', message: 'no', status: 403 }))
        const client = new LivequeryClient({ storage: new LivequeryMemoryStorage(), transporters: { rest: transporter } })
        const col = new LivequeryCollection<Todo>(client, { ssr: false, mode: 'local-first' })
        col.initialize('todos')
        await tick()

        await col.add({ title: 'not allowed' })
        expect(col.items.value[0]!.value._adding_error?.code).toBe('FORBIDDEN')
        expect(await client.outbox.pending()).toEqual([])
        client.destroy()
    })
})

describe('sync status', () => {
    test('pending$ counts the writes waiting, and drops to zero once they are synced', async () => {
        let online = false
        const { transporter } = makeTransporter(() => online ? undefined : { code: 'NETWORK_ERROR', message: 'offline' })
        const client = new LivequeryClient({ storage: new LivequeryMemoryStorage(), transporters: { rest: transporter } })
        const col = new LivequeryCollection<Todo>(client, { ssr: false, mode: 'local-first' })
        col.initialize('todos')
        const counts: number[] = []
        client.outbox.pending$.subscribe((entries: OutboxEntry[]) => counts.push(entries.length))
        await tick()

        await col.add({ title: 'a' })
        await col.add({ title: 'b' })
        await waitUntil(() => counts.at(-1) === 2)

        online = true
        client.outbox.trigger()
        await waitUntil(() => counts.at(-1) === 0)
        expect(counts).toContain(2)
        client.destroy()
    })
})

describe('a queue that cannot be written', () => {
    test('storage refusing the outbox entry (quota) — the document says so, the mutation does not throw', async () => {
        const storage = new LivequeryMemoryStorage()
        const add = storage.add.bind(storage)
        storage.add = (async (collection: string, document: any) => {
            if (collection === LIVEQUERY_OUTBOX_REF) throw new DOMException('quota', 'QuotaExceededError')
            return await add(collection, document)
        }) as typeof storage.add
        const { transporter, sent } = makeTransporter(() => undefined)
        const client = new LivequeryClient({ storage, transporters: { rest: transporter } })
        const col = new LivequeryCollection<Todo>(client, { ssr: false, mode: 'local-first' })
        col.initialize('todos')
        await tick()

        const result = await col.add({ title: 'no room' })
        expect(result).toBeUndefined()
        const doc = col.items.value[0]!.value
        expect(doc.title).toBe('no room')
        expect(doc._adding_error?.code).toBe('OUTBOX_WRITE_FAILED')
        expect(sent).toEqual([])
        client.destroy()
    })
})
