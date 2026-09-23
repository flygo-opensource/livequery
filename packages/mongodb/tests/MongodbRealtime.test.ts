import { EventEmitter } from 'events'
import { describe, expect, test } from 'bun:test'
import { firstValueFrom, take, toArray } from 'rxjs'
import { MongodbRealtime, type MongoRealtimeFailure } from '../src/MongodbRealtime.js'

function createWatchableCollection(name: string, commandError?: Error) {
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
                if (commandError) throw commandError
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

/** Let every already-scheduled macrotask run, so "nothing happened" is a real assertion. */
async function settle() {
    for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 0))
}

const unauthorized = Object.assign(
    new Error('not authorized on main to execute command { collMod: "products" }'),
    { code: 13 }
)

describe('MongodbRealtime', () => {
    test('watches realtime collection routes and emits formatted insert changes', async () => {
        const products = createWatchableCollection('products')
        const db = createDb({ products })
        const realtime = new MongodbRealtime()

        const result = firstValueFrom(realtime.watch(
            { connections: { default: db as any } },
            [{ schema: 'products', options: { collection: 'products', realtime: true } }]
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
            [{ schema: 'products', options: { collection: 'products', realtime: true } }]
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

    test('formats nested refs from path param fields', async () => {
        const posts = createWatchableCollection('posts')
        const db = createDb({ posts })
        const realtime = new MongodbRealtime({ enablePreAndPostImages: false })

        const results = firstValueFrom(realtime.watch(
            { connections: { default: db as any } },
            [{
                schema: 'users/:userId/posts',
                options: { collection: 'posts', realtime: true },
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

    test('a scalar ref field changing removes the document from the old parent and adds it to the new', async () => {
        const videos = createWatchableCollection('videos')
        const db = createDb({ videos })
        const realtime = new MongodbRealtime({ enablePreAndPostImages: false })

        const results = firstValueFrom(realtime.watch(
            { connections: { default: db as any } },
            [{
                schema: 'status/:status/videos',
                options: { collection: 'videos', realtime: true },
            }]
        ).pipe(take(2), toArray()))

        await waitFor(() => videos.watchCalls.length > 0)
        videos.stream.emit('change', {
            operationType: 'update',
            ns: { db: 'main', coll: 'videos' },
            fullDocumentBeforeChange: { _id: 'video1', status: 'running', amount: 10 },
            fullDocument: { _id: 'video1', status: 'stopped', amount: 0 },
            updateDescription: {
                updatedFields: { status: 'stopped', amount: 0 },
                removedFields: [],
            },
        })

        expect(await results).toEqual([
            {
                ref: 'status/running/videos',
                type: 'removed',
                data: { id: 'video1' },
            },
            {
                // The document is new to this ref, so it carries the whole document.
                ref: 'status/stopped/videos',
                type: 'added',
                data: { id: 'video1', status: 'stopped', amount: 0 },
            },
        ])
    })

    test('emits removed changes from delete events', async () => {
        const products = createWatchableCollection('products')
        const db = createDb({ products })
        const realtime = new MongodbRealtime({ enablePreAndPostImages: false })

        const result = firstValueFrom(realtime.watch(
            { connections: { default: db as any } },
            [{ schema: 'products', options: { collection: 'products', realtime: true } }]
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

    test('delete without pre-image falls back to documentKey for the removed id', async () => {
        const products = createWatchableCollection('products')
        const db = createDb({ products })
        const realtime = new MongodbRealtime({ enablePreAndPostImages: false })

        const result = firstValueFrom(realtime.watch(
            { connections: { default: db as any } },
            [{ schema: 'products', options: { collection: 'products', realtime: true } }]
        ))

        await waitFor(() => products.watchCalls.length > 0)
        // No fullDocumentBeforeChange: collections without changeStreamPreAndPostImages
        // only get documentKey on delete events.
        products.stream.emit('change', {
            operationType: 'delete',
            ns: { db: 'main', coll: 'products' },
            documentKey: { _id: 'p9' },
        })

        expect(await result).toEqual({
            ref: 'products',
            type: 'removed',
            data: { id: 'p9' },
        })
    })

    test('maps replace events to modified changes', async () => {
        const products = createWatchableCollection('products')
        const db = createDb({ products })
        const realtime = new MongodbRealtime({ enablePreAndPostImages: false })

        const result = firstValueFrom(realtime.watch(
            { connections: { default: db as any } },
            [{ schema: 'products', options: { collection: 'products', realtime: true } }]
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
                { schema: 'drafts', options: { collection: 'products', realtime: false } },
                { schema: 'dynamic-collection', options: { collection: (() => 'products') as any, realtime: true } },
                { schema: 'dynamic-db', options: { collection: 'products', db: (() => 'main') as any, realtime: true } },
                { schema: 'dynamic-connection', options: { collection: 'products', connection: (() => 'default') as any, realtime: true } },
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
            [{ schema: 'products', options: { collection: 'products', realtime: true } }]
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
            [{ schema: 'products', options: { collection: 'products', db: 'tenant', realtime: true } }]
        ).subscribe()

        await waitFor(() => tenantProducts.watchCalls.length > 0)
        sub.unsubscribe()

        expect(client.dbCalls).toEqual(['tenant'])
        expect(tenantDb.collectionCalls).toEqual(['products'])
    })

    test('array membership changes fan out removed / modified / added per parent', async () => {
        const posts = createWatchableCollection('posts')
        const db = createDb({ posts })
        const realtime = new MongodbRealtime({ enablePreAndPostImages: false })

        const results = firstValueFrom(realtime.watch(
            { connections: { default: db as any } },
            [{
                schema: 'users/:userIds/posts',
                options: { collection: 'posts', realtime: true },
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
                ref: 'users/user1/posts',                       // left the group
                type: 'removed',
                data: { id: 'post1' },
            },
            {
                ref: 'users/user2/posts',                       // stayed, only the field changed
                type: 'modified',
                data: { id: 'post1', userIds: ['user2', 'user3'] },
            },
            {
                ref: 'users/user3/posts',                       // joined, so it needs the document
                type: 'added',
                data: { id: 'post1', userIds: ['user2', 'user3'], title: 'Hello' },
            },
        ])
    })

    test('retries after stream errors', async () => {
        const products = createWatchableCollection('products')
        const db = createDb({ products })
        const realtime = new MongodbRealtime({ enablePreAndPostImages: false, reconnectDelayMs: 1 })

        const sub = realtime.watch(
            { connections: { default: db as any } },
            [{ schema: 'products', options: { collection: 'products', realtime: true } }]
        ).subscribe()

        await waitFor(() => products.watchCalls.length > 0)
        products.stream.emit('error', new Error('transient stream failure'))
        await waitFor(() => products.watchCalls.length > 1)
        sub.unsubscribe()

        expect(products.stream.closed).toBe(true)
    })

    test('waits out the backoff before resubscribing a dropped stream', async () => {
        const products = createWatchableCollection('products')
        const db = createDb({ products })
        const failures: MongoRealtimeFailure[] = []
        const realtime = new MongodbRealtime({
            enablePreAndPostImages: false,
            reconnectDelayMs: 10_000,
            onError: (_error, failure) => failures.push(failure),
        })

        const sub = realtime.watch(
            { connections: { default: db as any } },
            [{ schema: 'products', options: { collection: 'products', realtime: true } }]
        ).subscribe()

        await waitFor(() => products.watchCalls.length > 0)
        products.stream.emit('error', new Error('transient stream failure'))
        await settle()
        sub.unsubscribe()

        // A bare retry() resubscribed immediately, which is how a permanent failure became a
        // busy loop against mongod. The resubscribe must still be pending here.
        expect(products.watchCalls.length).toBe(1)
        expect(failures).toEqual([{ stage: 'watch', attempt: 1 }])
    })

    test('starts the watcher when collMod is not permitted', async () => {
        const products = createWatchableCollection('products', unauthorized)
        const db = createDb({ products })
        const failures: Array<[unknown, MongoRealtimeFailure]> = []
        const realtime = new MongodbRealtime({ onError: (error, failure) => failures.push([error, failure]) })

        const result = firstValueFrom(realtime.watch(
            { connections: { default: db as any } },
            [{ schema: 'products', options: { collection: 'products', realtime: true } }]
        ))

        await waitFor(() => products.watchCalls.length > 0)
        products.stream.emit('change', {
            operationType: 'delete',
            ns: { db: 'main', coll: 'products' },
            documentKey: { _id: 'p1' },
        })

        // Without pre-images a delete carries no before-image, so old_data falls back to the
        // document key — degraded, but still a usable `removed` event.
        expect(await result).toEqual({ ref: 'products', type: 'removed', data: { id: 'p1' } })
        expect(failures).toEqual([[unauthorized, { stage: 'collMod', collection: 'products' }]])
    })

    test('does not re-issue collMod once it has been refused', async () => {
        const products = createWatchableCollection('products', unauthorized)
        const db = createDb({ products })
        const realtime = new MongodbRealtime({ reconnectDelayMs: 1, onError: () => { } })

        const sub = realtime.watch(
            { connections: { default: db as any } },
            [{ schema: 'products', options: { collection: 'products', realtime: true } }]
        ).subscribe()

        await waitFor(() => products.watchCalls.length > 0)
        products.stream.emit('error', new Error('transient stream failure'))
        await waitFor(() => products.watchCalls.length > 1)
        sub.unsubscribe()

        expect(products.db.commandCalls.length).toBe(1)
    })
})
