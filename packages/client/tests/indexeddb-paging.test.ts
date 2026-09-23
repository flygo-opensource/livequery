import { describe, expect, test } from 'bun:test'
import { IDBFactory, IDBIndex, IDBKeyRange } from 'fake-indexeddb'
import { LivequeryIndexedDBStorage } from '../src/LivequeryIndexedDBStorage.js'
import { queryDocs } from '../src/helpers/queryDocs.js'

type Msg = { id: string, text: string, created_at?: number, author?: { name: string } }

// The scan reads a collection with `getAll` on the collection index; an indexed page never does.
const scans = { count: 0 }
const getAll = IDBIndex.prototype.getAll
IDBIndex.prototype.getAll = function (this: IDBIndex, ...args: any[]) {
    scans.count++
    return (getAll as any).apply(this, args)
}

let seq = 0
const storageOf = (factory = new IDBFactory(), indexAfter = 10) =>
    new LivequeryIndexedDBStorage({ name: `paging-${seq++}`, indexedDB: factory, keyRange: IDBKeyRange, indexAfter })

// Ties on purpose: several messages share a created_at, so the id tie-break decides.
function messages(count: number): Msg[] {
    return Array.from({ length: count }, (_, i) => ({
        id: `m${String((i * 7919) % 1000).padStart(3, '0')}`,
        text: `#${i}`,
        created_at: Math.floor(i / 3),
        author: { name: ['bob', 'alice', 'mike'][i % 3]! },
    }))
}

async function seed(storage: LivequeryIndexedDBStorage, ref: string, docs: Msg[]) {
    for (const doc of docs) await storage.add(ref, doc)
}

// Every page, walked with the returned cursors, forwards then backwards.
async function walk(read: (filters: Record<string, any>) => Promise<{ documents: Msg[], paging: any }>, base: Record<string, any>) {
    const pages: Array<{ ids: string[], paging: any }> = []
    let page = await read(base)
    pages.push({ ids: page.documents.map(d => d.id), paging: page.paging })
    while (page.paging.next) {
        page = await read({ ...base, ':after': page.paging.next.cursor })
        pages.push({ ids: page.documents.map(d => d.id), paging: page.paging })
    }
    while (page.paging.prev) {
        page = await read({ ...base, ':before': page.paging.prev.cursor })
        pages.push({ ids: page.documents.map(d => d.id), paging: page.paging })
    }
    return pages
}

async function indexNames(factory: IDBFactory, name: string) {
    const db: IDBDatabase = await new Promise((resolve, reject) => {
        const request = factory.open(name)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })
    const names = [...db.transaction('docs').objectStore('docs').indexNames]
    db.close()
    return names
}

describe('IndexedDB paging from an index', () => {
    for (const [label, base] of [
        ['created_at desc', { ':limit': 7, 'created_at:sort': 'desc' }],
        ['created_at asc', { ':limit': 7, 'created_at:sort': 'asc' }],
        ['nested author.name asc', { ':limit': 5, 'author.name:sort': 'asc' }],
        ['no sort (id desc)', { ':limit': 6 }],
    ] as const) {
        test(`pages exactly like the in-memory reference — ${label}`, async () => {
            const docs = messages(40)
            const storage = storageOf()
            await seed(storage, 'chats/c1/messages', docs)
            await seed(storage, 'chats/c2/messages', messages(5))  // another collection in the same store

            await storage.query('chats/c1/messages', base)  // first read scans and creates the index
            const expected = await walk(async f => queryDocs(docs, f), base)
            const before = scans.count
            const actual = await walk(f => storage.query<Msg>('chats/c1/messages', f), base)
            expect(actual).toEqual(expected)
            expect(scans.count - before).toBe(0)
            await storage.close()
        })
    }

    test('a large enough collection gets an index for its sort field; a small one does not', async () => {
        const factory = new IDBFactory()
        const name = `sizes-${seq++}`
        const storage = new LivequeryIndexedDBStorage({ name, indexedDB: factory, keyRange: IDBKeyRange, indexAfter: 20 })
        await seed(storage, 'small', messages(5))
        await seed(storage, 'big', messages(30))
        await storage.query('small', { ':limit': 3, 'text:sort': 'asc' })
        await storage.query('big', { ':limit': 3, 'created_at:sort': 'desc' })
        // The index is created in the background, after the scan answered.
        await storage.query('big', { ':limit': 3, 'created_at:sort': 'desc' })
        await storage.close()
        const names = await indexNames(factory, name)
        expect(names).toContain('order:created_at')
        expect(names).not.toContain('order:text')
    })

    test('a document without the sort field is in the index too, placed like the reference', async () => {
        const docs: Msg[] = [...messages(20), { id: 'zz-no-date', text: 'no date' }]
        const storage = storageOf()
        await seed(storage, 'c', docs)
        const base = { ':limit': 4, 'created_at:sort': 'desc' }
        await storage.query('c', base)
        const before = scans.count
        expect(await walk(f => storage.query<Msg>('c', f), base)).toEqual(await walk(async f => queryDocs(docs, f), base))
        expect(scans.count - before).toBe(0)
        await storage.close()
    })

    test('writes after the index exists show up in the pages', async () => {
        const docs = messages(30)
        const storage = storageOf()
        await seed(storage, 'c', docs)
        const base = { ':limit': 10, 'created_at:sort': 'desc' }
        await storage.query('c', base)
        await storage.add('c', { id: 'new', text: 'new', created_at: 999 })
        await storage.update('c', docs[0]!.id, { created_at: 500 })
        await storage.delete('c', docs[1]!.id)
        const now = [
            { id: 'new', text: 'new', created_at: 999 },
            { ...docs[0]!, created_at: 500 },
            ...docs.slice(2),
        ]
        const page = await storage.query<Msg>('c', base)
        expect(page.documents.map(d => d.id).slice(0, 2)).toEqual(['new', docs[0]!.id])
        expect(await walk(f => storage.query<Msg>('c', f), base)).toEqual(await walk(async f => queryDocs(now, f), base))
        await storage.close()
    })

    test('total stays exact through writes, without reading the collection', async () => {
        const storage = storageOf()
        await seed(storage, 'c', messages(30))
        const base = { ':limit': 5, 'created_at:sort': 'desc' }
        await storage.query('c', base)
        await storage.add('c', { id: 'x1', text: 'x', created_at: 100 })
        await storage.add('c', { id: 'x1', text: 'x again', created_at: 100 })  // same id: a replace
        await storage.delete('c', 'x1')
        await storage.delete('c', 'x1')  // already gone
        await storage.add('c', { id: 'x2', text: 'y', created_at: 101 })
        const before = scans.count
        const page = await storage.query<Msg>('c', base)
        expect(scans.count - before).toBe(0)
        expect(page.paging.total).toBe(31)
        expect(page.paging.next?.count).toBe(26)
        await storage.close()
    })

    test('other filters still go through the scan', async () => {
        const docs = messages(30)
        const storage = storageOf()
        await seed(storage, 'c', docs)
        const base = { ':limit': 4, 'created_at:sort': 'desc', 'author.name': 'bob' }
        await storage.query('c', { ':limit': 4, 'created_at:sort': 'desc' })
        expect(await walk(f => storage.query<Msg>('c', f), base)).toEqual(await walk(async f => queryDocs(docs, f), base))
        await storage.close()
    })

    test('a second connection to the same database keeps working through the upgrade', async () => {
        const factory = new IDBFactory()
        const name = `shared-${seq++}`
        const a = new LivequeryIndexedDBStorage({ name, indexedDB: factory, keyRange: IDBKeyRange, indexAfter: 10 })
        const b = new LivequeryIndexedDBStorage({ name, indexedDB: factory, keyRange: IDBKeyRange, indexAfter: 10 })
        const docs = messages(25)
        await seed(a, 'c', docs)
        expect((await b.query('c', { ':limit': 5 })).documents).toHaveLength(5)  // b holds a connection

        const base = { ':limit': 5, 'created_at:sort': 'asc' }
        // a's scan starts the upgrade; b keeps reading and writing meanwhile.
        const reads = await Promise.all([
            a.query<Msg>('c', base),
            b.query<Msg>('c', base),
            b.add('c', { id: 'during', text: 'during', created_at: -1 }),
            a.query<Msg>('c', base),
        ])
        expect(reads[0].documents).toHaveLength(5)
        const after = await b.query<Msg>('c', base)
        expect(after.documents[0]!.id).toBe('during')
        expect(await indexNames(factory, name)).toContain('order:created_at')
        await a.close()
        await b.close()
    })

    test('mixed types, emoji, and mixed id kinds page in the same order from the index as in memory', async () => {
        const values: unknown[] = [null, undefined, 3, -1, 2.5, 'b', 'B', '\u{1F600}', '\uFF01', '', true, false, 10, '10']
        const docs: any[] = values.map((value, i) => ({ id: i % 3 === 0 ? `0192${String(i).padStart(4, '0')}-0000-7000-8000-000000000000` : i % 3 === 1 ? `65${String(i).padStart(22, '0')}` : `x${i}`, rank: value, text: `#${i}` }))
        const storage = storageOf(new IDBFactory(), 5)
        await seed(storage, 'c', docs)
        for (const base of [{ ':limit': 3, 'rank:sort': 'asc' }, { ':limit': 4, 'rank:sort': 'desc' }, { ':limit': 3 }]) {
            await storage.query('c', base)
            const before = scans.count
            expect(await walk(f => storage.query<Msg>('c', f), base)).toEqual(await walk(async f => queryDocs(docs, f), base))
            expect(scans.count - before).toBe(0)
        }
        await storage.close()
    })

    test('a field holding arrays: the scan answers, ordered by smallest / largest element like MongoDB', async () => {
        const docs: any[] = [
            { id: 'a', tags: [5, 1] }, { id: 'b', tags: [3] }, { id: 'c', tags: 2 }, { id: 'd', tags: [] }, { id: 'e', tags: null },
            ...messages(12).map(m => ({ ...m, tags: 7 })),
        ]
        const storage = storageOf(new IDBFactory(), 5)
        await seed(storage, 'c', docs)
        const base = { ':limit': 4, 'tags:sort': 'asc' }
        await storage.query('c', base)
        const before = scans.count
        const pages = await walk(f => storage.query<Msg>('c', f), base)
        expect(pages).toEqual(await walk(async f => queryDocs(docs, f), base))
        expect(scans.count - before).toBeGreaterThan(0)
        // [] < null < a (min 1) < c (2) < b (3)
        expect(pages[0]!.ids).toEqual(['d', 'e', 'a', 'c'])
        const desc = await storage.query<any>('c', { ':limit': 3, 'tags:sort': 'desc' })
        // largest element first: 7s…, then a (max 5)
        expect(desc.documents.map(d => d.id).includes('a')).toBe(false)
        await storage.close()
    })
})
