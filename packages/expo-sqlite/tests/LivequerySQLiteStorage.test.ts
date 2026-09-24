import { describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { of } from 'rxjs'
import { LivequeryClient, LivequeryCollection, type LivequeryTransporter } from '@livequery/client'
import { defineStorageConformanceSuite } from '@livequery/client/testing'
import { LivequerySQLiteStorage } from '../src/index.js'
import { openTestDatabase } from './sqlite.js'

defineStorageConformanceSuite({
    name: 'LivequerySQLiteStorage',
    create: () => new LivequerySQLiteStorage({ database: openTestDatabase() }),
    describe,
    test,
    expect,
})

defineStorageConformanceSuite({
    name: 'LivequerySQLiteStorage without cache',
    create: () => new LivequerySQLiteStorage({ database: openTestDatabase(), cache: false }),
    describe,
    test,
    expect,
})

const file = () => join(tmpdir(), `livequery-sqlite-${crypto.randomUUID()}.db`)

describe('LivequerySQLiteStorage', () => {
    test('data survives a new storage on the same file — an app restart', async () => {
        const path = file()
        try {
            const first = new LivequerySQLiteStorage({ database: openTestDatabase(path) })
            await first.add('todos', { id: 'local:1', title: 'kept', _adding: true } as any)
            await first.add('__livequery_outbox', { id: 'w1', type: 'add', ref: 'todos' } as any)
            await first.query('todos')
            await first.update('todos', 'local:1', { id: 'srv-1', _adding: undefined })

            const second = new LivequerySQLiteStorage({ database: openTestDatabase(path) })
            expect(await second.get<any>('todos', 'srv-1')).toEqual({ id: 'srv-1', title: 'kept' })
            expect(await second.get('todos', 'local:1')).toBeNull()
            expect((await second.query<any>('__livequery_outbox')).documents).toEqual([{ id: 'w1', type: 'add', ref: 'todos' }])
        } finally {
            rmSync(path, { force: true })
        }
    })

    test('a failed re-key leaves the document where it was, in SQLite and in memory', async () => {
        const database = openTestDatabase()
        const storage = new LivequerySQLiteStorage({ database })
        await storage.add('todos', { id: 'local:1', title: 'draft' } as any)
        await storage.query('todos')
        const broken = {
            ...database,
            withExclusiveTransactionAsync: (task: any) => database.withExclusiveTransactionAsync(async transaction => {
                await task(transaction)
                throw new Error('disk full')
            }),
        }
        const failing = new LivequerySQLiteStorage({ database: broken })
        await failing.query('todos')
        await expect(failing.update('todos', 'local:1', { id: 'srv-1' })).rejects.toThrow('disk full')
        expect(await failing.get<any>('todos', 'local:1')).toEqual({ id: 'local:1', title: 'draft' })
        expect(await failing.get('todos', 'srv-1')).toBeNull()
        expect(await storage.get<any>('todos', 'local:1')).toEqual({ id: 'local:1', title: 'draft' })
    })

    test('operations run in call order: concurrent updates all land', async () => {
        const storage = new LivequerySQLiteStorage({ database: openTestDatabase(), cache: false })
        await storage.add('counters', { id: 'c', n: 0 } as any)
        await Promise.all(Array.from({ length: 50 }, (_, i) => storage.update('counters', 'c', { [`k${i}`]: i })))
        const doc = await storage.get<any>('counters', 'c')
        expect(Object.keys(doc).filter(k => k.startsWith('k'))).toHaveLength(50)
    })

    test('a local-first collection reads what an earlier session stored, before the server answers', async () => {
        const path = file()
        const transporter: LivequeryTransporter = {
            query: () => of({ changes: [], source: 'query' as const }),
            read: async () => ({ changes: [{ collection_ref: 'todos', id: 't1', type: 'added', data: { id: 't1', title: 'from server', updated_at: 1 } }], paging: { total: 1, current: 1 }, sync: true, source: 'query' }),
            add: async (_ref, doc) => doc as any,
            update: async (_ref, id, patch) => ({ id, ...patch }) as any,
            delete: async (_ref, id) => ({ id }) as any,
            trigger: async () => ({}) as any,
        }
        // @ts-ignore initialize() guards on window
        globalThis.window ??= globalThis
        try {
            const first = new LivequeryClient({ storage: new LivequerySQLiteStorage({ database: openTestDatabase(path) }), transporters: { rest: transporter } })
            const online = new LivequeryCollection<any>(first, { mode: 'local-first' })
            const a = online.initialize('todos')
            await waitUntil(() => online.status.value === 'ready' && online.items.value.length === 1)
            a?.unsubscribe()

            const offline: LivequeryTransporter = { ...transporter, read: () => new Promise(() => undefined) }
            const second = new LivequeryClient({ storage: new LivequerySQLiteStorage({ database: openTestDatabase(path) }), transporters: { rest: offline } })
            const restarted = new LivequeryCollection<any>(second, { mode: 'local-first' })
            const b = restarted.initialize('todos')
            await waitUntil(() => restarted.items.value.length === 1)
            expect(restarted.items.value[0]!.value.title).toBe('from server')
            b?.unsubscribe()
        } finally {
            rmSync(path, { force: true })
        }
    })
})

async function waitUntil(check: () => boolean, ms = 3000) {
    const started = Date.now()
    while (!check()) {
        if (Date.now() - started > ms) throw new Error('timed out')
        await new Promise(resolve => setTimeout(resolve, 10))
    }
}
