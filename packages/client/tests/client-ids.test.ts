/**
 * Client-chosen ids against a server that keeps them (the 3.0 datasources): the id a document gets
 * at add time is final, and a retried add cannot create a duplicate.
 */

import { describe, expect, test } from 'bun:test'
import { NEVER } from 'rxjs'
import { LivequeryClient } from '../src/LivequeryClient.js'
import { LivequeryCollection } from '../src/LivequeryCollection.js'
import { LivequeryMemoryStorage } from '../src/LivequeryMemoryStorage.js'
import type { Doc, DocState, LivequeryTransporter } from '../src/index.js'

type Todo = Doc<{ title: string, parent_id?: string }>

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

async function waitUntil(check: () => boolean | Promise<boolean>, ms = 2000) {
    const started = Date.now()
    while (!(await check())) {
        if (Date.now() - started > ms) throw new Error('timed out')
        await tick(10)
    }
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Keeps the client's id; a second add with the same id answers 409 ID_ALREADY_EXISTS. */
function makeServer() {
    const docs = new Map<string, Record<string, any>>()
    const calls: Array<{ op: string, id?: string, body?: Record<string, any> }> = []
    const state = { online: true, lose_next_response: false }
    const transporter: LivequeryTransporter = {
        query: () => NEVER,
        add: async (_ref, body: any) => {
            if (!state.online) throw { code: 'NETWORK_ERROR', message: 'offline' }
            calls.push({ op: 'add', body })
            if (docs.has(body.id)) throw { code: 'ID_ALREADY_EXISTS', message: 'taken', status: 409 }
            docs.set(body.id, { ...body })
            if (state.lose_next_response) {
                // Written on the server, but the answer never makes it back.
                state.lose_next_response = false
                throw { code: 'NETWORK_ERROR', message: 'response lost' }
            }
            return { ...body } as any
        },
        update: async (_ref, id, body) => {
            if (!state.online) throw { code: 'NETWORK_ERROR', message: 'offline' }
            calls.push({ op: 'update', id, body })
            const doc = { ...docs.get(id), ...body, id }
            docs.set(id, doc)
            return doc as any
        },
        delete: async (_ref, id) => {
            if (!state.online) throw { code: 'NETWORK_ERROR', message: 'offline' }
            calls.push({ op: 'delete', id })
            docs.delete(id)
            return { id } as any
        },
        trigger: async () => ({}) as any,
    }
    return { transporter, docs, calls, state }
}

function makeClient(server = makeServer()) {
    const client = new LivequeryClient({ storage: new LivequeryMemoryStorage(), transporters: { rest: server.transporter } })
    const col = new LivequeryCollection<Todo>(client, { ssr: false, mode: 'local-first' })
    col.initialize('todos')
    return { client, col, server }
}

describe('client-chosen ids', () => {
    test('the id given at add time is the id on the server — nothing is renamed', async () => {
        const { client, col, server } = makeClient()
        await tick()
        const created = await col.add({ title: 'a' }) as DocState<Todo>

        expect(created.id).toMatch(UUID_V7)
        expect(server.docs.get(created.id)).toEqual({ id: created.id, title: 'a' })
        expect(col.items.value.map(d => d.value.id)).toEqual([created.id])
        client.destroy()
    })

    test('lost response — the retry gets 409, the client recognises its own add: one document, no error', async () => {
        const { client, col, server } = makeClient()
        await tick()
        server.state.lose_next_response = true

        const result = await col.add({ title: 'once' }) as DocState<Todo>
        expect(result._queued).toBe(true)
        expect(server.docs.size).toBe(1)

        client.outbox.trigger()
        await waitUntil(async () => (await client.outbox.pending()).length === 0)
        expect(server.docs.size).toBe(1)
        const doc = col.items.value[0]!.value
        expect(doc.id).toBe(result.id)
        expect(doc._adding).toBeUndefined()
        expect(doc._adding_error).toBeUndefined()
        expect(server.calls.map(c => c.op)).toEqual(['add', 'add', 'update'])
        client.destroy()
    })

    test('lost response, then an edit before the retry — the server ends with the edit', async () => {
        const { client, col, server } = makeClient()
        await tick()
        server.state.lose_next_response = true
        const result = await col.add({ title: 'first' }) as DocState<Todo>
        await col.update({ id: result.id, title: 'edited' })

        client.outbox.trigger()
        await waitUntil(async () => (await client.outbox.pending()).length === 0)
        expect(server.docs.size).toBe(1)
        expect(server.docs.get(result.id)?.title).toBe('edited')
        expect(col.items.value[0]!.value._prev).toBeUndefined()
        client.destroy()
    })

    test('409 on the first attempt is a real conflict — the error lands on the document', async () => {
        const { client, col, server } = makeClient()
        await tick()
        const id = '01890a5d-ac96-774b-bcce-b302099a8057'
        server.docs.set(id, { id, title: 'someone else' })

        await col.add({ id, title: 'mine' })
        const doc = col.items.value.find(d => d.value.id === id)!.value
        expect(doc._adding_error?.code).toBe('ID_ALREADY_EXISTS')
        expect(server.docs.get(id)?.title).toBe('someone else')
        expect(server.calls.map(c => c.op)).toEqual(['add'])
        client.destroy()
    })

    test('offline, a new document can point at another new document — the reference survives sync', async () => {
        const { client, col, server } = makeClient()
        await tick()
        server.state.online = false
        const parent = await col.add({ title: 'parent' }) as DocState<Todo>
        const child = await col.add({ title: 'child', parent_id: parent.id }) as DocState<Todo>

        server.state.online = true
        client.outbox.trigger()
        await waitUntil(async () => (await client.outbox.pending()).length === 0)
        expect(server.docs.get(child.id)?.parent_id).toBe(parent.id)
        expect(server.docs.has(parent.id)).toBe(true)
        client.destroy()
    })

    test('deleting a document whose add was never sent sends nothing', async () => {
        const { client, col, server } = makeClient()
        await tick()
        server.state.online = false
        const draft = await col.add({ title: 'draft' }) as DocState<Todo>
        await col.delete(draft.id)
        expect(col.items.value).toHaveLength(0)
        expect(await client.outbox.pending()).toEqual([])

        server.state.online = true
        client.outbox.trigger()
        await tick(50)
        expect(server.calls).toEqual([])
        client.destroy()
    })
})
