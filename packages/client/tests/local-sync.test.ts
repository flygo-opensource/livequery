/**
 * LivequerySync: what a local-first collection declares (`mode: { scope, size, keep, evict,
 * children }`) is what lives on the device, kept in sync with deltas and realtime; the collection
 * pages through storage and only reaches the server past what the device holds.
 */

import { describe, expect, test } from 'bun:test'
import { BehaviorSubject, Observable, Subject } from 'rxjs'
import { LivequeryClient } from '../src/LivequeryClient.js'
import { LivequeryCollection } from '../src/LivequeryCollection.js'
import { LivequeryMemoryStorage } from '../src/LivequeryMemoryStorage.js'
import { LIVEQUERY_SYNC_REF, mergeLocalFirstConfigs } from '../src/LivequerySync.js'
import type { DataChangeEvent, Doc, LivequeryQueryParams, LivequeryQueryResult, LivequeryStorage, LivequeryTransporter } from '../src/index.js'

type Msg = Doc<{ text: string, created_at: number, updated_at: number, deleted_at?: number }>

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

async function waitUntil(check: () => boolean | Promise<boolean>, ms = 3000) {
    const started = Date.now()
    while (!(await check())) {
        if (Date.now() - started > ms) throw new Error('timed out')
        await tick(10)
    }
}

/**
 * A sync server: pages by cursor, answers deltas (`updated_at:gte`), keeps tombstones, and says so
 * (`sync: true`). `{ sync: false }` is a route without sync: documents still carry `updated_at`,
 * but a delete removes the document and `:tombstones` means nothing.
 */
function makeServer({ sync = true } = {}) {
    const data = new Map<string, Map<string, Record<string, any>>>()
    const realtime = new Map<string, Subject<DataChangeEvent>>()
    const state = { online: true, clock: 1_000 }
    const reads: Array<{ ref: string, filters: Record<string, any> }> = []
    let live = 0

    const collection = (ref: string) => data.get(ref) ?? data.set(ref, new Map()).get(ref)!
    const channel = (ref: string) => realtime.get(ref) ?? realtime.set(ref, new Subject()).get(ref)!

    const read = ({ ref, filters = {} }: LivequeryQueryParams<any>): Partial<LivequeryQueryResult> => {
        if (!state.online) return { error: { code: 'NETWORK_ERROR', message: 'offline' }, source: 'query' }
        reads.push({ ref, filters: { ...filters } })
        const f = filters as Record<string, any>
        let docs = [...collection(ref).values()]
        if (!f[':tombstones']) docs = docs.filter(d => d.deleted_at == null)
        if (f['updated_at:gt'] != null) docs = docs.filter(d => d.updated_at > f['updated_at:gt'])
        if (f['updated_at:gte'] != null) docs = docs.filter(d => d.updated_at >= f['updated_at:gte'])
        const sort = Object.entries(f).find(([k]) => k.endsWith(':sort'))
        const [field, direction] = sort ? [sort[0].slice(0, -5), sort[1]] : ['id', 'desc']
        docs.sort((a, b) => {
            const order = a[field] === b[field] ? (a.id < b.id ? -1 : 1) : a[field] < b[field] ? -1 : 1
            return direction === 'asc' ? order : -order
        })
        const start = f[':after'] ? docs.findIndex(d => d.id === f[':after']) + 1 : 0
        const limit = Number(f[':limit']) || docs.length
        const page = docs.slice(start, start + limit)
        const more = start + limit < docs.length
        return {
            changes: page.map(d => ({ collection_ref: ref, id: d.id, type: 'added', data: { ...d } })),
            paging: { total: docs.length, current: page.length, ...more ? { next: { count: docs.length - start - limit, cursor: page.at(-1)!.id } } : {} },
            ...sync ? { sync: true } : {},
            source: 'query',
        }
    }

    const transporter: LivequeryTransporter = {
        read: async params => read(params),
        query: params => new Observable(subscriber => {
            subscriber.next(read(params))
            live++
            const sub = channel(params.ref).subscribe(change => subscriber.next({ changes: [change], source: 'realtime' }))
            return () => {
                live--
                sub.unsubscribe()
            }
        }),
        add: async (ref, doc: any) => server.put(ref, doc) as any,
        update: async (ref, id, patch: any) => server.put(ref, { ...collection(ref).get(id), ...patch, id }) as any,
        delete: async (ref, id) => server.remove(ref, id) as any,
        trigger: async () => ({}) as any,
    }

    const server = {
        transporter,
        state,
        reads,
        get live() { return live },
        collection,
        /** Insert or replace; bumps updated_at; realtime. */
        put(ref: string, doc: Record<string, any>) {
            const existed = collection(ref).has(doc.id)
            const stored = { ...doc, updated_at: ++state.clock }
            collection(ref).set(doc.id, stored)
            channel(ref).next({ collection_ref: ref, id: doc.id, type: existed ? 'modified' : 'added', data: { ...stored } })
            return stored
        },
        /** Soft delete: a tombstone that deltas return. */
        remove(ref: string, id: string) {
            const doc = collection(ref).get(id)
            if (!doc) return null
            if (!sync) {
                collection(ref).delete(id)
                channel(ref).next({ collection_ref: ref, id, type: 'removed' })
                return doc
            }
            const tombstone = { ...doc, deleted_at: ++state.clock, updated_at: state.clock }
            collection(ref).set(id, tombstone)
            channel(ref).next({ collection_ref: ref, id, type: 'removed' })
            return doc
        },
        /** Change data without realtime: what a device misses while its socket is down. */
        quietly(ref: string, doc: Record<string, any>) {
            collection(ref).set(doc.id, { ...collection(ref).get(doc.id), ...doc, updated_at: ++state.clock })
        },
        /** A write whose version is older than what was already read: stamped, then committed late. */
        quietlyAt(ref: string, doc: Record<string, any>, version: number) {
            collection(ref).set(doc.id, { ...collection(ref).get(doc.id), ...doc, updated_at: version })
        },
        quietlyRemove(ref: string, id: string) {
            const doc = collection(ref).get(id)!
            if (!sync) return void collection(ref).delete(id)
            collection(ref).set(id, { ...doc, deleted_at: ++state.clock, updated_at: state.clock })
        },
    }
    return server
}

type Server = ReturnType<typeof makeServer>

function seedMessages(server: Server, ref: string, count: number) {
    for (let i = 1; i <= count; i++) server.put(ref, { id: `m${String(i).padStart(3, '0')}`, text: `#${i}`, created_at: i })
}

// No overlap by default: the fake clock ticks by 1, so any overlap would re-read everything.
function makeClient(server: Server, storage: LivequeryStorage = new LivequeryMemoryStorage(), syncOverlap = 0) {
    return new LivequeryClient({ storage, transporters: { rest: server.transporter }, syncOverlap })
}

function open(client: LivequeryClient, ref: string, mode: any, limit = 20) {
    const col = new LivequeryCollection<Msg>(client, { ssr: false, mode, filters: { ':limit': limit, 'created_at:sort': 'desc' } as any })
    const linker = col.initialize(ref)
    return { col, close: () => linker?.unsubscribe() }
}

const texts = (col: LivequeryCollection<Msg>) => col.items.value.map(d => d.value.text)
const readsOf = (server: Server, ref: string) => server.reads.filter(r => r.ref === ref).length

describe('config', () => {
    test('declarations for one ref merge to the widest', () => {
        const merged = mergeLocalFirstConfigs([
            { scope: 'window', size: 50, keep: '10m' },
            { scope: 'window', size: 200, keep: '1h', children: { 'a/:id/b': { scope: 'on-demand' } } },
            { scope: 'on-demand', keep: 'always' },
        ])
        expect(merged).toMatchObject({ scope: 'window', size: 200, keep: 'always' })
        expect(merged.children?.['a/:id/b']).toEqual({ scope: 'on-demand' })
        expect(mergeLocalFirstConfigs([{ scope: 'window', size: 10 }, {}]).scope).toBe('full')
    })
})

describe("scope 'full'", () => {
    test('loads everything once; the collection pages through storage without the server', async () => {
        const server = makeServer()
        seedMessages(server, 'chats/c1/messages', 250)
        const client = makeClient(server)
        const { col } = open(client, 'chats/c1/messages', { scope: 'full' })

        await waitUntil(() => col.items.value.length === 20 && col.completeness.value === 'complete')
        expect(texts(col)[0]).toBe('#250')
        const reads = readsOf(server, 'chats/c1/messages')

        for (let page = 0; page < 20 && col.paging.value.next; page++) await col.loadMore()
        expect(col.items.value).toHaveLength(250)
        expect(new Set(texts(col)).size).toBe(250)
        expect(readsOf(server, 'chats/c1/messages')).toBe(reads)
        client.destroy()
    })
})

describe("scope 'window'", () => {
    test('holds the newest `size`; scrolling past it loads older pages and keeps them', async () => {
        const server = makeServer()
        seedMessages(server, 'chats/c1/messages', 120)
        const storage = new LivequeryMemoryStorage()
        const client = makeClient(server, storage)
        const { col } = open(client, 'chats/c1/messages', { scope: 'window', size: 50 })

        await waitUntil(() => col.items.value.length === 20 && col.completeness.value === 'partial')
        expect((await storage.query('chats/c1/messages')).documents).toHaveLength(50)

        await col.loadMore()
        await col.loadMore()
        expect(col.items.value).toHaveLength(60)
        expect(texts(col).at(-1)).toBe('#61')

        for (let page = 0; page < 10 && col.paging.value.next; page++) await col.loadMore()
        expect(col.items.value).toHaveLength(120)
        expect(col.completeness.value).toBe('complete')
        expect((await storage.query('chats/c1/messages')).documents).toHaveLength(120)
        client.destroy()
    })

    test('offline past the window: nothing more, completeness stays partial, a cursor stays to retry', async () => {
        const server = makeServer()
        seedMessages(server, 'chats/c1/messages', 80)
        const client = makeClient(server)
        const { col } = open(client, 'chats/c1/messages', { scope: 'window', size: 40 })
        await waitUntil(() => col.completeness.value === 'partial')
        await col.loadMore()
        expect(col.items.value).toHaveLength(40)

        server.state.online = false
        await col.loadMore()
        expect(col.items.value).toHaveLength(40)
        expect(col.completeness.value).toBe('partial')
        expect(col.paging.value.next).toBeTruthy()

        server.state.online = true
        await col.loadMore()
        expect(col.items.value).toHaveLength(60)
        client.destroy()
    })
})

describe('staying in sync', () => {
    test('realtime while open: a new message shows at the top, within the window', async () => {
        const server = makeServer()
        seedMessages(server, 'chats/c1/messages', 30)
        const client = makeClient(server)
        const { col } = open(client, 'chats/c1/messages', 'local-first')
        await waitUntil(() => col.items.value.length === 20)

        server.put('chats/c1/messages', { id: 'm999', text: 'live', created_at: 999 })
        await waitUntil(() => texts(col)[0] === 'live')
        expect(col.items.value).toHaveLength(20)
        client.destroy()
    })

    test('reopening later fetches only what changed (a delta), tombstones included', async () => {
        const server = makeServer()
        seedMessages(server, 'chats/c1/messages', 60)
        const storage = new LivequeryMemoryStorage()
        const first = makeClient(server, storage)
        const a = open(first, 'chats/c1/messages', { scope: 'full', keep: 0 })
        await waitUntil(() => a.col.completeness.value === 'complete')
        a.close()
        first.destroy()

        // While nobody watched: one edit, one delete, one new message.
        server.quietly('chats/c1/messages', { id: 'm060', text: 'edited' })
        server.quietlyRemove('chats/c1/messages', 'm059')
        server.quietly('chats/c1/messages', { id: 'm061', text: 'new', created_at: 61 })
        const reads_before = server.reads.length

        const second = makeClient(server, storage)
        const b = open(second, 'chats/c1/messages', { scope: 'full' })
        await waitUntil(() => texts(b.col)[0] === 'new' && texts(b.col).includes('edited') && !texts(b.col).includes('#59'))
        const delta = server.reads.slice(reads_before).find(r => r.filters['updated_at:gte'] != null)
        expect(delta?.filters[':tombstones']).toBe(1)
        expect(await storage.get('chats/c1/messages', 'm059')).toBeNull()
        second.destroy()
    })

    // Documents with `updated_at` do not make a route a sync route. 3.0.0 read deltas as soon as it
    // saw one, so a document deleted on a route without tombstones stayed on the device forever.
    test('a route without sync is re-read, not delta-read: a server-side delete leaves the device', async () => {
        const server = makeServer({ sync: false })
        seedMessages(server, 'tasks', 5)
        const storage = new LivequeryMemoryStorage()
        const first = makeClient(server, storage)
        const a = open(first, 'tasks', { scope: 'full', keep: 0 })
        await waitUntil(() => a.col.completeness.value === 'complete')
        a.close()
        first.destroy()

        server.quietlyRemove('tasks', 'm003')
        const reads_before = server.reads.length

        const second = makeClient(server, storage)
        const b = open(second, 'tasks', { scope: 'full' })
        await waitUntil(async () => (await storage.get('tasks', 'm003')) === null)
        expect(texts(b.col)).not.toContain('#3')
        expect(server.reads.slice(reads_before).some(r => r.filters['updated_at:gte'] != null)).toBe(false)
        second.destroy()
    })

    test('a device synced by 3.0.0 (`versioned`, no `sync`) re-reads once, then reads deltas again', async () => {
        const server = makeServer()
        seedMessages(server, 'tasks', 5)
        const storage = new LivequeryMemoryStorage()
        const first = makeClient(server, storage)
        const a = open(first, 'tasks', { scope: 'full', keep: 0 })
        await waitUntil(() => a.col.completeness.value === 'complete')
        a.close()
        first.destroy()
        const { sync: _sync, ...legacy } = (await storage.get<any>(LIVEQUERY_SYNC_REF, 'tasks'))!
        await storage.update(LIVEQUERY_SYNC_REF, 'tasks', { ...legacy, sync: undefined, versioned: true } as any)

        const reads_before = server.reads.length
        const second = makeClient(server, storage)
        const b = open(second, 'tasks', { scope: 'full', keep: 0 })
        await waitUntil(() => server.reads.length > reads_before && !b.col.loading?.value)
        await tick(50)
        expect(server.reads.slice(reads_before).some(r => r.filters['updated_at:gte'] != null)).toBe(false)
        b.close()
        second.destroy()

        const reads_after = server.reads.length
        const third = makeClient(server, storage)
        const c = open(third, 'tasks', { scope: 'full' })
        await waitUntil(() => server.reads.slice(reads_after).some(r => r.filters['updated_at:gte'] != null))
        c.close()
        third.destroy()
    })

    test('a reconnect catches the open collection up on what realtime missed', async () => {
        const server = makeServer()
        seedMessages(server, 'chats/c1/messages', 5)
        const status$ = new BehaviorSubject({ connected: true })
        server.transporter.status$ = status$
        const client = makeClient(server)
        const { col } = open(client, 'chats/c1/messages', { scope: 'full', keep: 'always' })
        await waitUntil(() => col.items.value.length === 5)

        // The socket drops; meanwhile the server changes without a realtime event reaching us.
        status$.next({ connected: false })
        server.quietly('chats/c1/messages', { id: 'm005', text: 'edited' })
        server.quietly('chats/c1/messages', { id: 'm006', text: 'new', created_at: 6 })
        status$.next({ connected: true })

        await waitUntil(() => texts(col)[0] === 'new' && texts(col).includes('edited'))
        client.destroy()
    })

    for (const [overlap, caught] of [[5, true], [0, false]] as const) {
        test(`a write committed after the read that passed its version: ${caught ? 'caught by the overlap' : 'missed without one'}`, async () => {
            const server = makeServer()
            seedMessages(server, 'chats/c1/messages', 5)
            const storage = new LivequeryMemoryStorage()
            const first = makeClient(server, storage, overlap)
            const a = open(first, 'chats/c1/messages', { scope: 'full', keep: 0 })
            await waitUntil(() => a.col.completeness.value === 'complete')
            a.close()
            first.destroy()

            // Stamped a moment before the newest version the device read, committed after it.
            const newest = Math.max(...[...server.collection('chats/c1/messages').values()].map(d => d.updated_at))
            server.quietlyAt('chats/c1/messages', { id: 'm003', text: 'late' }, newest - 2)

            const second = makeClient(server, storage, overlap)
            const b = open(second, 'chats/c1/messages', { scope: 'full' })
            await waitUntil(() => b.col.completeness.value === 'complete')
            await tick(100)
            expect(texts(b.col).includes('late')).toBe(caught)
            second.destroy()
        })
    }

    test("keep: realtime stays for `keep` after the last collection closes, then stops", async () => {
        const server = makeServer()
        seedMessages(server, 'chats/c1/messages', 5)
        const client = makeClient(server)
        const { col, close } = open(client, 'chats/c1/messages', { keep: 80 })
        await waitUntil(() => col.items.value.length === 5)
        expect(server.live).toBe(1)
        close()
        await tick(20)
        expect(server.live).toBe(1)
        await waitUntil(() => server.live === 0)
        client.destroy()
    })
})

describe('children', () => {
    test("every chat's messages are on the device before the chat is opened — and readable offline", async () => {
        const server = makeServer()
        for (const chat of ['c1', 'c2', 'c3']) {
            server.put('accounts/a1/chats', { id: chat, text: chat, created_at: 1 })
            seedMessages(server, `chats/${chat}/messages`, 30)
        }
        const storage = new LivequeryMemoryStorage()
        const client = makeClient(server, storage)
        const chats = open(client, 'accounts/a1/chats', {
            scope: 'full',
            children: { 'chats/:id/messages': { scope: 'window', size: 10, sort: { created_at: 'desc' } } },
        })
        await waitUntil(async () => {
            for (const chat of ['c1', 'c2', 'c3']) {
                if ((await storage.query(`chats/${chat}/messages`)).documents.length < 10) return false
            }
            return true
        })

        server.state.online = false
        const messages = open(client, 'chats/c2/messages', 'local-first', 5)
        await waitUntil(() => messages.col.items.value.length === 5)
        expect(texts(messages.col)[0]).toBe('#30')
        client.destroy()
    })

    test('a chat created later brings its messages along; a deleted chat releases them', async () => {
        const server = makeServer()
        const client = makeClient(server)
        const storage = new LivequeryMemoryStorage()
        const sync_client = makeClient(server, storage)
        open(sync_client, 'accounts/a1/chats', { scope: 'full', children: { 'chats/:id/messages': { scope: 'window', size: 5 } } })
        await tick(50)

        seedMessages(server, 'chats/c9/messages', 8)
        server.put('accounts/a1/chats', { id: 'c9', text: 'c9', created_at: 2 })
        await waitUntil(async () => (await storage.query('chats/c9/messages')).documents.length === 5)
        client.destroy()
        sync_client.destroy()
    })
})

describe('persistence', () => {
    test("keep 'always' scopes resume on the next start, with no UI, and catch up by delta", async () => {
        const server = makeServer()
        seedMessages(server, 'chats/c1/messages', 10)
        const storage = new LivequeryMemoryStorage()
        const first = makeClient(server, storage)
        open(first, 'chats/c1/messages', { scope: 'full', keep: 'always' })
        await waitUntil(async () => (await storage.query('chats/c1/messages')).documents.length === 10)
        await tick(30)
        first.destroy()

        server.quietly('chats/c1/messages', { id: 'm011', text: 'while away', created_at: 11 })
        const second = makeClient(server, storage)
        await waitUntil(async () => !!(await storage.get('chats/c1/messages', 'm011')))
        second.destroy()
    })

    test('scopes unused past `evict` lose their local copy, but not writes still waiting to go out', async () => {
        const server = makeServer()
        seedMessages(server, 'chats/old/messages', 5)
        const storage = new LivequeryMemoryStorage()
        const first = makeClient(server, storage)
        const a = open(first, 'chats/old/messages', { scope: 'full', keep: 0, evict: '1d' })
        await waitUntil(async () => (await storage.query('chats/old/messages')).documents.length === 5)
        a.close()
        await tick(30)
        first.destroy()
        await storage.add('chats/old/messages', { id: 'draft', text: 'unsent', created_at: 9, _adding: true } as any)
        await storage.update(LIVEQUERY_SYNC_REF, 'chats/old/messages', { last_used_at: Date.now() - 2 * 86_400_000 })

        const second = makeClient(server, storage)
        await waitUntil(async () => (await storage.query('chats/old/messages')).documents.length === 1)
        expect(await storage.get('chats/old/messages', 'draft')).toBeTruthy()
        expect(await storage.get(LIVEQUERY_SYNC_REF, 'chats/old/messages')).toBeNull()
        second.destroy()
    })
})
