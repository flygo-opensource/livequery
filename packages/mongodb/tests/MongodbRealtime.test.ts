import { EventEmitter } from 'events'
import { describe, expect, test } from 'bun:test'
import { firstValueFrom, take, toArray } from 'rxjs'
import { MongodbRealtime } from '../src/MongodbRealtime.js'

function createWatchableCollection(name: string) {
    const stream = Object.assign(new EventEmitter(), {
        closed: false,
        close() {
            this.closed = true
        },
    })
    const collection = {
        name,
        watchCalls: [] as any[],
        db: {
            commandCalls: [] as any[],
            async command(command: any) {
                this.commandCalls.push(command)
            },
        },
        watch(pipeline: any[], options: any) {
            collection.watchCalls.push({ pipeline, options })
            return stream
        },
        stream,
    }
    return collection
}

function createDb(collections: Record<string, ReturnType<typeof createWatchableCollection>>) {
    return {
        collectionCalls: [] as string[],
        collection(name: string) {
            this.collectionCalls.push(name)
            return collections[name]
        },
    }
}

function createClient(databases: Record<string, ReturnType<typeof createDb>>) {
    return {
        dbCalls: [] as Array<string | undefined>,
        db(name?: string) {
            this.dbCalls.push(name)
            const db = databases[name || '']
            if (!db) throw new Error(`Missing mock db "${name}"`)
            return db
        },
    }
}

async function waitFor(check: () => boolean) {
    for (let i = 0; i < 20; i++) {
        if (check()) return
        await new Promise(resolve => setTimeout(resolve, 0))
    }
    throw new Error('Timed out waiting for condition')
}

describe('MongodbRealtime', () => {
    test('watches realtime collection routes and emits formatted insert changes', async () => {
        const products = createWatchableCollection('products')
        const db = createDb({ products })
        const realtime = new MongodbRealtime()

        const result = firstValueFrom(realtime.watch(
            { connections: { default: db as any } },
            [{ method: 'GET', path: '/products', collection: 'products', realtime: true }]
        ))

        await waitFor(() => products.watchCalls.length > 0)
        products.stream.emit('change', {
            operationType: 'insert',
            ns: { db: 'main', coll: 'products' },
            fullDocument: { _id: 'p1', name: 'Phone', _private: true },
        })

        expect(await result).toEqual({
            ref: 'products',
            type: 'added',
            data: { id: 'p1', name: 'Phone' },
        })
        expect(products.db.commandCalls[0]).toEqual({
            collMod: 'products',
            changeStreamPreAndPostImages: { enabled: true },
        })
        expect(products.watchCalls[0].options).toEqual({
            fullDocument: 'updateLookup',
            fullDocumentBeforeChange: 'whenAvailable',
        })
    })

    test('emits modified changes with only changed public fields', async () => {
        const products = createWatchableCollection('products')
        const db = createDb({ products })
        const realtime = new MongodbRealtime({ enablePreAndPostImages: false })

        const result = firstValueFrom(realtime.watch(
            { connections: { default: db as any } },
            [{ method: 0, path: '/products', options: { collection: 'products', realtime: true } }]
        ))

        await waitFor(() => products.watchCalls.length > 0)
        products.stream.emit('change', {
            operationType: 'update',
            ns: { db: 'main', coll: 'products' },
            fullDocumentBeforeChange: { _id: 'p1', name: 'Old', stock: 1 },
            fullDocument: { _id: 'p1', name: 'New', stock: 1 },
            updateDescription: {
                updatedFields: { name: 'New', _internal: true },
                removedFields: [],
            },
        })

        expect(await result).toEqual({
            ref: 'products',
            type: 'modified',
            data: { id: 'p1', name: 'New' },
        })
        expect(products.db.commandCalls).toEqual([])
    })

    test('formats nested refs through route refFields', async () => {
        const posts = createWatchableCollection('posts')
        const db = createDb({ posts })
        const realtime = new MongodbRealtime({ enablePreAndPostImages: false })

        const results = firstValueFrom(realtime.watch(
            { connections: { default: db as any } },
            [{
                method: 'GET',
                path: '/users/:id/posts',
                collection: 'posts',
                realtime: true,
                refFields: { id: 'userId' },
            }]
        ).pipe(take(1), toArray()))

        await waitFor(() => posts.watchCalls.length > 0)
        posts.stream.emit('change', {
            operationType: 'insert',
            ns: { db: 'main', coll: 'posts' },
            fullDocument: { _id: 'post1', userId: 'user1', title: 'Hello' },
        })

        expect(await results).toEqual([{
            ref: 'users/user1/posts',
            type: 'added',
            data: { id: 'post1', userId: 'user1', title: 'Hello' },
        }])
    })

    test('emits removed changes from delete events', async () => {
        const products = createWatchableCollection('products')
        const db = createDb({ products })
        const realtime = new MongodbRealtime({ enablePreAndPostImages: false })

        const result = firstValueFrom(realtime.watch(
            { connections: { default: db as any } },
            [{ method: 'GET', path: '/products', collection: 'products', realtime: true }]
        ))

        await waitFor(() => products.watchCalls.length > 0)
        products.stream.emit('change', {
            operationType: 'delete',
            ns: { db: 'main', coll: 'products' },
            fullDocumentBeforeChange: { _id: 'p1', name: 'Phone' },
        })

        expect(await result).toEqual({
            ref: 'products',
            type: 'removed',
            data: { id: 'p1' },
        })
    })

    test('maps replace events to modified changes', async () => {
        const products = createWatchableCollection('products')
        const db = createDb({ products })
        const realtime = new MongodbRealtime({ enablePreAndPostImages: false })

        const result = firstValueFrom(realtime.watch(
            { connections: { default: db as any } },
            [{ method: 'GET', path: '/products', collection: 'products', realtime: true }]
        ))

        await waitFor(() => products.watchCalls.length > 0)
        products.stream.emit('change', {
            operationType: 'replace',
            ns: { db: 'main', coll: 'products' },
            fullDocumentBeforeChange: { _id: 'p1', name: 'Old' },
            fullDocument: { _id: 'p1', name: 'New' },
        })

        expect(await result).toEqual({
            ref: 'products',
            type: 'modified',
            data: { id: 'p1' },
        })
    })

    test('skips routes that cannot be watched up front', async () => {
        const products = createWatchableCollection('products')
        const db = createDb({ products })
        const realtime = new MongodbRealtime({ enablePreAndPostImages: false })

        const emissions: any[] = []
        realtime.watch(
            { connections: { default: db as any } },
            [
                { method: 'POST', path: '/products', collection: 'products', realtime: true },
                { method: 'GET', path: '/drafts', collection: 'products', realtime: false },
                { method: 'GET', path: '/dynamic-collection', collection: (() => 'products') as any, realtime: true },
                { method: 'GET', path: '/dynamic-db', collection: 'products', db: (() => 'main') as any, realtime: true },
                { method: 'GET', path: '/dynamic-connection', collection: 'products', connection: (() => 'default') as any, realtime: true },
            ]
        ).subscribe(value => emissions.push(value))

        await new Promise(resolve => setTimeout(resolve, 0))

        expect(emissions).toEqual([])
        expect(db.collectionCalls).toEqual([])
        expect(products.watchCalls).toEqual([])
    })

    test('watches every configured database when using a MongoClient', async () => {
        const mainProducts = createWatchableCollection('products')
        const archiveProducts = createWatchableCollection('products')
        const mainDb = createDb({ products: mainProducts })
        const archiveDb = createDb({ products: archiveProducts })
        const client = createClient({ main: mainDb, archive: archiveDb })
        const realtime = new MongodbRealtime({ enablePreAndPostImages: false })

        const sub = realtime.watch(
            { connections: { default: client as any }, databases: ['main', 'archive'] },
            [{ method: 'GET', path: '/products', collection: 'products', realtime: true }]
        ).subscribe()

        await waitFor(() => mainProducts.watchCalls.length > 0 && archiveProducts.watchCalls.length > 0)
        sub.unsubscribe()

        expect(client.dbCalls).toEqual(['main', 'archive'])
        expect(mainDb.collectionCalls).toEqual(['products'])
        expect(archiveDb.collectionCalls).toEqual(['products'])
    })

    test('uses route db before configured databases when using a MongoClient', async () => {
        const tenantProducts = createWatchableCollection('products')
        const tenantDb = createDb({ products: tenantProducts })
        const client = createClient({ tenant: tenantDb })
        const realtime = new MongodbRealtime({ enablePreAndPostImages: false })

        const sub = realtime.watch(
            { connections: { default: client as any }, databases: ['main', 'archive'] },
            [{ method: 'GET', path: '/products', collection: 'products', db: 'tenant', realtime: true }]
        ).subscribe()

        await waitFor(() => tenantProducts.watchCalls.length > 0)
        sub.unsubscribe()

        expect(client.dbCalls).toEqual(['tenant'])
        expect(tenantDb.collectionCalls).toEqual(['products'])
    })

    test('formats nested array refs as added and removed membership changes', async () => {
        const posts = createWatchableCollection('posts')
        const db = createDb({ posts })
        const realtime = new MongodbRealtime({ enablePreAndPostImages: false })

        const results = firstValueFrom(realtime.watch(
            { connections: { default: db as any } },
            [{
                method: 'GET',
                path: '/users/:id/posts',
                collection: 'posts',
                realtime: true,
                refFields: { id: { field: 'userIds', array: true } },
            }]
        ).pipe(take(3), toArray()))

        await waitFor(() => posts.watchCalls.length > 0)
        posts.stream.emit('change', {
            operationType: 'update',
            ns: { db: 'main', coll: 'posts' },
            fullDocumentBeforeChange: { _id: 'post1', userIds: ['user1', 'user2'], title: 'Hello' },
            fullDocument: { _id: 'post1', userIds: ['user2', 'user3'], title: 'Hello' },
            updateDescription: {
                updatedFields: { userIds: ['user2', 'user3'] },
                removedFields: [],
            },
        })

        expect(await results).toEqual([
            {
                ref: 'users/user1/posts',
                type: 'removed',
                data: { id: 'post1' },
            },
            {
                ref: 'users/user2/posts',
                type: 'modified',
                data: { id: 'post1', userIds: ['user2', 'user3'] },
            },
            {
                ref: 'users/user3/posts',
                type: 'added',
                data: { id: 'post1', userIds: ['user2', 'user3'], title: 'Hello' },
            },
        ])
    })

    test('retries after stream errors', async () => {
        const products = createWatchableCollection('products')
        const db = createDb({ products })
        const realtime = new MongodbRealtime({ enablePreAndPostImages: false })

        const sub = realtime.watch(
            { connections: { default: db as any } },
            [{ method: 'GET', path: '/products', collection: 'products', realtime: true }]
        ).subscribe()

        await waitFor(() => products.watchCalls.length > 0)
        products.stream.emit('error', new Error('transient stream failure'))
        await waitFor(() => products.watchCalls.length > 1)
        sub.unsubscribe()

        expect(products.stream.closed).toBe(true)
    })
})
