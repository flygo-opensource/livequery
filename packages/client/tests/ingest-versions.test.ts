/**
 * The ingest path is the only way server data reaches storage. Realtime and sync reads can deliver
 * the same document out of order; `updated_at` decides, and `deleted_at` tombstones delete.
 */

import { describe, expect, test } from 'bun:test'
import { ReplaySubject } from 'rxjs'
import { LivequeryClient } from '../src/LivequeryClient.js'
import { LivequeryCollection } from '../src/LivequeryCollection.js'
import { LivequeryMemoryStorage } from '../src/LivequeryMemoryStorage.js'
import type { DataChangeEvent, Doc, LivequeryQueryResult, LivequeryTransporter } from '../src/index.js'

type Note = Doc<{ text: string, updated_at: number, deleted_at?: number }>

const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms))

function setup() {
    const stream = new ReplaySubject<Partial<LivequeryQueryResult>>(100)
    const transporter: LivequeryTransporter = {
        query: () => stream,
        add: async (_ref, doc) => doc as any,
        update: async (_ref, id, doc) => ({ id, ...doc }) as any,
        delete: async (_ref, id) => ({ id }) as any,
        trigger: async () => ({}) as any,
    }
    const storage = new LivequeryMemoryStorage()
    const client = new LivequeryClient({ storage, transporters: { t: transporter } })
    const col = new LivequeryCollection<Note>(client, { ssr: false, mode: 'server-first' })
    col.initialize('notes')
    const push = (...changes: Array<Omit<DataChangeEvent, 'collection_ref'>>) =>
        stream.next({ changes: changes.map(c => ({ collection_ref: 'notes', ...c })), source: 'realtime' })
    stream.next({ changes: [], source: 'query' })
    return { client, col, storage, push }
}

describe('versioned ingest', () => {
    test('an older version arriving after a newer one is ignored', async () => {
        const { client, col, storage, push } = setup()
        await tick()
        push({ id: 'n1', type: 'added', data: { id: 'n1', text: 'v2', updated_at: 20 } })
        await tick()
        push({ id: 'n1', type: 'modified', data: { text: 'v1', updated_at: 10 } })
        push({ id: 'n1', type: 'added', data: { id: 'n1', text: 'v1', updated_at: 10 } })
        await tick()
        expect(await storage.get('notes', 'n1')).toMatchObject({ text: 'v2', updated_at: 20 })
        expect(col.items.value.find(d => d.value.id === 'n1')?.value.text).toBe('v2')
        client.destroy()
    })

    test('the same version again, or a newer one, applies', async () => {
        const { client, storage, push } = setup()
        await tick()
        push({ id: 'n1', type: 'added', data: { id: 'n1', text: 'v1', updated_at: 10 } })
        push({ id: 'n1', type: 'modified', data: { text: 'v1b', updated_at: 10 } })
        await tick()
        expect(await storage.get('notes', 'n1')).toMatchObject({ text: 'v1b' })
        push({ id: 'n1', type: 'modified', data: { text: 'v3', updated_at: 30 } })
        await tick()
        expect(await storage.get('notes', 'n1')).toMatchObject({ text: 'v3', updated_at: 30 })
        client.destroy()
    })

    test('a tombstone removes the document from storage and from the list', async () => {
        const { client, col, storage, push } = setup()
        await tick()
        push({ id: 'n1', type: 'added', data: { id: 'n1', text: 'bye', updated_at: 10 } })
        await tick()
        expect(col.items.value).toHaveLength(1)
        push({ id: 'n1', type: 'modified', data: { id: 'n1', text: 'bye', updated_at: 11, deleted_at: 11 } })
        await tick()
        expect(await storage.get('notes', 'n1')).toBeNull()
        expect(col.items.value).toHaveLength(0)
        client.destroy()
    })

    test('a tombstone for a document this device never had adds nothing', async () => {
        const { client, col, storage, push } = setup()
        await tick()
        push({ id: 'gone', type: 'added', data: { id: 'gone', text: 'x', updated_at: 5, deleted_at: 5 } })
        await tick()
        expect(await storage.get('notes', 'gone')).toBeNull()
        expect(col.items.value).toHaveLength(0)
        client.destroy()
    })

    test('an older tombstone does not delete a newer document', async () => {
        const { client, storage, push } = setup()
        await tick()
        push({ id: 'n1', type: 'added', data: { id: 'n1', text: 'restored', updated_at: 50 } })
        await tick()
        push({ id: 'n1', type: 'modified', data: { id: 'n1', updated_at: 40, deleted_at: 40 } })
        await tick()
        expect(await storage.get('notes', 'n1')).toMatchObject({ text: 'restored' })
        client.destroy()
    })
})
