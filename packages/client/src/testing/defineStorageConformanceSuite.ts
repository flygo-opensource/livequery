import type { LivequeryStorage } from '../LivequeryStorage.js'
import { filterDocs } from '../helpers/filterDocs.js'
import { sortDocs } from '../helpers/sortDocs.js'

/** The slice of a test runner the suite needs; bun:test, vitest and jest all fit. */
export type StorageConformanceRunner = {
    describe: (name: string, fn: () => void) => void
    test: (name: string, fn: () => Promise<void>) => void
    expect: (value: unknown) => any
}

export type StorageConformanceOptions = StorageConformanceRunner & {
    /** Label for the describe block, e.g. `LivequeryIndexedDBStorage`. */
    name: string
    /** A fresh, empty storage per test. */
    create: () => LivequeryStorage | Promise<LivequeryStorage>
    /** Tear the storage down after each test. */
    dispose?: (storage: LivequeryStorage) => void | Promise<void>
}

type Item = {
    id: string
    title: string
    done: boolean
    rank: number
    meta: { group: string, score: number }
    tags: string[]
}

const ITEMS: Item[] = [
    { id: 'a', title: 'alpha', done: false, rank: 3, meta: { group: 'x', score: 10 }, tags: ['one'] },
    { id: 'b', title: 'bravo', done: true, rank: 1, meta: { group: 'y', score: 30 }, tags: [] },
    { id: 'c', title: 'charlie', done: false, rank: 2, meta: { group: 'x', score: 20 }, tags: ['one', 'two'] },
    { id: 'd', title: 'delta', done: true, rank: 5, meta: { group: 'z', score: 5 }, tags: ['two'] },
]

const FILTER_CASES: Array<Record<string, any>> = [
    {},
    { 'done:eq-boolean': 'true' },
    { 'rank:gt': 1, 'rank:sort': 'desc' },
    { 'rank:lte': 3, 'title:sort': 'asc' },
    { 'meta.group': 'x', 'meta.score:sort': 'desc' },
    { 'title:like': 'ha' },
    { 'title:in': '["alpha","delta"]' },
    { 'done:eq-boolean': 'false', ':limit': 1, ':after': 'a' },
]

/**
 * Contract every `LivequeryStorage` adapter must honour. The client's offline logic (outbox, conflict
 * rebase, id remap) calls nothing but these six methods, so an adapter that passes this suite —
 * IndexedDB, MMKV, SQLite, or your own — can back an offline-first client.
 *
 *   import { describe, test, expect } from 'bun:test'
 *   import { defineStorageConformanceSuite } from '@livequery/client/testing'
 *
 *   defineStorageConformanceSuite({ name: 'MyStorage', create: () => new MyStorage(), describe, test, expect })
 */
export function defineStorageConformanceSuite(options: StorageConformanceOptions) {
    const { describe, test, expect } = options

    const run = (name: string, fn: (storage: LivequeryStorage) => Promise<void>) => test(name, async () => {
        const storage = await options.create()
        try {
            await fn(storage)
        } finally {
            await options.dispose?.(storage)
        }
    })

    const seed = async (storage: LivequeryStorage) => {
        for (const item of ITEMS) await storage.add('items', item)
    }

    describe(`LivequeryStorage conformance — ${options.name}`, () => {
        run('add keeps a given id and assigns a local: id when there is none', async storage => {
            const kept = await storage.add('items', { id: 'x1', title: 'kept' } as any)
            expect(kept.id).toBe('x1')
            const assigned = await storage.add('items', { title: 'assigned' } as any)
            expect(String(assigned.id).startsWith('local:')).toBe(true)
            expect(await storage.get('items', assigned.id)).toEqual(assigned)
        })

        run('get returns the full document, or null when it does not exist', async storage => {
            await seed(storage)
            expect(await storage.get('items', 'c')).toEqual(ITEMS[2])
            expect(await storage.get('items', 'nope')).toBeNull()
            expect(await storage.get('elsewhere', 'c')).toBeNull()
        })

        run('documents round-trip as plain JSON: nested objects, arrays, null', async storage => {
            const doc = { id: 'j', nested: { deep: { list: [1, { two: 2 }] } }, empty: null, flag: false }
            await storage.add('items', doc as any)
            expect(await storage.get('items', 'j')).toEqual(doc)
        })

        run('update merges the patch and returns the whole document', async storage => {
            await seed(storage)
            const updated = await storage.update('items', 'a', { title: 'alpha-2', _prev: { title: 'alpha' } })
            expect(updated).toEqual({ ...ITEMS[0], title: 'alpha-2', _prev: { title: 'alpha' } })
            expect(await storage.get('items', 'a')).toEqual(updated)
        })

        run('update of a missing document returns null and creates nothing', async storage => {
            expect(await storage.update('items', 'ghost', { title: 'x' })).toBeNull()
            expect(await storage.get('items', 'ghost')).toBeNull()
        })

        run('update with a new id moves the document to that id', async storage => {
            await storage.add('items', { id: 'local:1', title: 'draft', _adding: true } as any)
            const moved = await storage.update('items', 'local:1', { id: 'srv-1', _adding: undefined })
            expect(moved?.id).toBe('srv-1')
            expect(await storage.get('items', 'local:1')).toBeNull()
            expect((await storage.get<any>('items', 'srv-1'))?.title).toBe('draft')
            const { documents } = await storage.query('items')
            expect(documents.map(d => d.id)).toEqual(['srv-1'])
        })

        run('delete returns the removed document, or null', async storage => {
            await seed(storage)
            expect(await storage.delete('items', 'b')).toEqual(ITEMS[1])
            expect(await storage.get('items', 'b')).toBeNull()
            expect(await storage.delete('items', 'b')).toBeNull()
        })

        run('collections are isolated from each other', async storage => {
            await storage.add('one', { id: 'same', v: 1 } as any)
            await storage.add('two', { id: 'same', v: 2 } as any)
            expect((await storage.get<any>('one', 'same'))?.v).toBe(1)
            await storage.delete('one', 'same')
            expect((await storage.get<any>('two', 'same'))?.v).toBe(2)
            expect((await storage.query('one')).documents).toEqual([])
        })

        run('query answers exactly like filterDocs, with paging totals', async storage => {
            await seed(storage)
            for (const filters of FILTER_CASES) {
                const sorters = Object.entries(filters).filter(([k]) => k.endsWith(':sort')) as Array<[string, 'asc' | 'desc']>
                const expected = sortDocs(filterDocs([...ITEMS], filters), sorters).map(d => d.id)
                const { documents, paging } = await storage.query('items', filters)
                const ids = documents.map(d => d.id)
                // Without a sort key the order is the adapter's own business.
                expect(sorters.length > 0 ? ids : [...ids].sort()).toEqual(sorters.length > 0 ? expected : [...expected].sort())
                expect(paging.total).toBe(ITEMS.length)
                expect(paging.current).toBe(expected.length)
            }
        })

        run('flush empties every collection', async storage => {
            await seed(storage)
            await storage.add('other', { id: 'o' } as any)
            await storage.flush()
            expect((await storage.query('items')).documents).toEqual([])
            expect(await storage.get('other', 'o')).toBeNull()
        })
    })
}
