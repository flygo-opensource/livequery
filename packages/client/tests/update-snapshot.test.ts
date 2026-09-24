/**
 * `doc.update({ ...doc.value, name })` — a form reset from the document, then submitted whole —
 * hands the client back a snapshot of its own write-state (`_adding`, `_prev`, `_updating`…).
 * Before 3.0.1 that snapshot overwrote the state the client had just computed, and the outbox
 * dropped the edit without a request: `_adding: true` from a dialog opened before the add was
 * confirmed read as "never created on the server", `_prev: undefined` from one opened after read
 * as "nothing left to send". The screen showed the edit; the server never heard of it.
 */
import { describe, expect, test } from 'bun:test'
import { NEVER } from 'rxjs'
import { LivequeryClient } from '../src/LivequeryClient.js'
import { LivequeryCollection } from '../src/LivequeryCollection.js'
import { LivequeryMemoryStorage } from '../src/LivequeryMemoryStorage.js'
import type { LivequeryTransporter } from '../src/index.js'

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

async function waitUntil(check: () => boolean, ms = 3000) {
    const started = Date.now()
    while (!check()) {
        if (Date.now() - started > ms) throw new Error('timed out')
        await tick(10)
    }
}

// A server that assigns its own ids (ObjectId-like) and takes a while to confirm an add.
function setup() {
    const calls: Array<{ op: string, id?: string, body: any }> = []
    let n = 0
    const transporter: LivequeryTransporter = {
        query: () => NEVER,
        add: async (_ref, body: any) => {
            calls.push({ op: 'add', body })
            await tick(150)
            return { ...body, id: `6650${String(++n).padStart(20, '0')}` }
        },
        update: async (_ref, id, body: any) => {
            calls.push({ op: 'update', id, body })
            return { id, ...body }
        },
        delete: async (_ref, id) => ({ id }) as any,
        trigger: async () => ({}) as any,
    }
    const client = new LivequeryClient({ storage: new LivequeryMemoryStorage(), transporters: { rest: transporter } })
    const col = new LivequeryCollection<any>(client, { ssr: false, mode: 'local-first' })
    col.initialize('providers')
    return { client, col, calls, confirmed: () => calls.some(c => c.op === 'add') && !col.items.value[0]?.value._adding }
}

const updates = (calls: Array<{ op: string }>) => calls.filter(c => c.op === 'update')

describe('update() with a snapshot of the document', () => {
    test('snapshot taken before the add was confirmed: the edit is still sent', async () => {
        const { client, col, calls, confirmed } = setup()
        await tick()
        col.add({ name: 'p1' })
        await waitUntil(() => col.items.value.length === 1)
        const doc = col.items.value[0]!
        const form = { ...doc.value }
        expect(form._adding).toBe(true)
        await waitUntil(confirmed)

        await doc.update({ ...form, name: 'renamed' })
        await waitUntil(() => updates(calls).length === 1)
        const [patch] = updates(calls)
        expect(patch.id).toBe(doc.value.id)
        expect(patch.body).toEqual({ name: 'renamed' })
        client.destroy()
    })

    test('snapshot taken after the add was confirmed: the edit is still sent', async () => {
        const { client, col, calls, confirmed } = setup()
        await tick()
        col.add({ name: 'p1' })
        await waitUntil(() => col.items.value.length === 1)
        await waitUntil(confirmed)
        const doc = col.items.value[0]!

        await doc.update({ ...doc.value, name: 'renamed' })
        await waitUntil(() => updates(calls).length === 1)
        expect(updates(calls)[0].body).toEqual({ name: 'renamed' })
        expect(doc.value.name).toBe('renamed')
        client.destroy()
    })

    test('add() of a copy of another document starts clean', async () => {
        const { client, col, calls, confirmed } = setup()
        await tick()
        col.add({ name: 'p1' })
        await waitUntil(() => col.items.value.length === 1)
        const copy = { ...col.items.value[0]!.value, id: undefined, name: 'p2' }
        await waitUntil(confirmed)

        await col.add(copy)
        await waitUntil(() => calls.filter(c => c.op === 'add').length === 2)
        expect(calls[1].body).toMatchObject({ name: 'p2' })
        expect(Object.keys(calls[1].body).filter(k => k.startsWith('_'))).toEqual([])
        client.destroy()
    })
})
