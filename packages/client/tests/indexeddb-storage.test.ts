import { describe, expect, test } from 'bun:test'
import { IDBFactory } from 'fake-indexeddb'
import { LivequeryIndexedDBStorage } from '../src/LivequeryIndexedDBStorage.js'
import { LivequeryMemoryStorage } from '../src/LivequeryMemoryStorage.js'
import { defineStorageConformanceSuite } from '../src/testing/index.js'

defineStorageConformanceSuite({
    name: 'LivequeryMemoryStorage',
    create: () => new LivequeryMemoryStorage(),
    describe,
    test,
    expect,
})

defineStorageConformanceSuite({
    name: 'LivequeryIndexedDBStorage',
    create: () => new LivequeryIndexedDBStorage({ indexedDB: new IDBFactory() }),
    dispose: storage => (storage as LivequeryIndexedDBStorage).close(),
    describe,
    test,
    expect,
})

defineStorageConformanceSuite({
    name: 'LivequeryIndexedDBStorage without indexedDB (memory fallback)',
    create: () => new LivequeryIndexedDBStorage(),
    describe,
    test,
    expect,
})

describe('LivequeryIndexedDBStorage', () => {
    test('data survives a new storage instance on the same database — a page reload', async () => {
        const factory = new IDBFactory()
        const first = new LivequeryIndexedDBStorage({ indexedDB: factory, name: 'reload' })
        await first.add('todos', { id: 'local:1', title: 'kept', _adding: true } as any)
        await first.close()

        const second = new LivequeryIndexedDBStorage({ indexedDB: factory, name: 'reload' })
        expect(await second.get('todos', 'local:1')).toEqual({ id: 'local:1', title: 'kept', _adding: true })
        await second.close()
    })

    test('an id change that fails half way leaves the old document untouched', async () => {
        const storage = new LivequeryIndexedDBStorage({ indexedDB: new IDBFactory() })
        await storage.add('todos', { id: 'local:1', title: 'draft' } as any)

        // A function cannot be structured-cloned: the put throws after the delete was issued, and
        // the delete must roll back with it.
        await expect(storage.update('todos', 'local:1', { id: 'srv-1', bad: () => 1 })).rejects.toBeDefined()

        expect(await storage.get('todos', 'local:1')).toEqual({ id: 'local:1', title: 'draft' })
        expect(await storage.get('todos', 'srv-1')).toBeNull()
        await storage.close()
    })

    test('shared is set per database name, and unset without indexedDB', () => {
        expect(new LivequeryIndexedDBStorage({ indexedDB: new IDBFactory(), name: 'app' }).shared).toBe('indexeddb:app')
        expect(new LivequeryIndexedDBStorage().shared).toBeUndefined()
    })

    test('close is idempotent and the storage reopens on next use', async () => {
        const storage = new LivequeryIndexedDBStorage({ indexedDB: new IDBFactory() })
        await storage.add('todos', { id: '1' } as any)
        await storage.close()
        await storage.close()
        expect(await storage.get('todos', '1')).toEqual({ id: '1' })
        await storage.close()
    })
})
