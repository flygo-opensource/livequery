import { describe, expect, test } from 'bun:test'
import { ObjectId } from 'mongodb'
import { MongodbCollection, defineCollection } from '../src/MongodbCollection.js'

// --- Minimal in-memory MongoDB fake -----------------------------------------
// Implements only the surface MongodbCollection uses, with real-enough filter
// matching (ObjectId equality + plain field equality) and $set/$inc updates so
// the wrapper is exercised end-to-end rather than against pure spies.

function valueEquals(a: any, b: any): boolean {
    if (a instanceof ObjectId || b instanceof ObjectId) {
        return a instanceof ObjectId && b instanceof ObjectId ? a.equals(b) : false
    }
    return a === b
}

function matches(doc: any, filter: any): boolean {
    return Object.entries(filter || {}).every(([k, v]) => valueEquals(doc[k], v))
}

function applyUpdate(doc: any, update: any) {
    if (update.$set) Object.assign(doc, update.$set)
    if (update.$inc) for (const [k, v] of Object.entries(update.$inc)) doc[k] = (doc[k] || 0) + (v as number)
}

function createFakeCollection() {
    const docs: any[] = []
    const calls = {
        updateOne: [] as any[],
        updateMany: [] as any[],
        deleteOne: [] as any[],
        findOne: [] as any[],
        aggregate: [] as any[],
    }
    const collection = {
        docs,
        calls,
        find(filter: any = {}) {
            return { toArray: async () => docs.filter((d) => matches(d, filter)) }
        },
        async findOne(filter: any = {}, opts?: any) {
            calls.findOne.push({ filter, opts })
            return docs.find((d) => matches(d, filter)) ?? null
        },
        insertSnapshots: [] as any[],
        async insertOne(doc: any) {
            collection.insertSnapshots.push({ keys: Object.keys(doc), hasId: 'id' in doc, hasRawId: '_id' in doc })
            if (!doc._id) doc._id = new ObjectId()
            docs.push(doc)
            return { insertedId: doc._id }
        },
        async insertMany(many: any[]) {
            const insertedIds: Record<number, ObjectId> = {}
            many.forEach((doc, i) => {
                if (!doc._id) doc._id = new ObjectId()
                docs.push(doc)
                insertedIds[i] = doc._id
            })
            return { insertedIds }
        },
        async updateOne(filter: any, update: any, opts?: any) {
            calls.updateOne.push({ filter, update, opts })
            const target = docs.find((d) => matches(d, filter))
            if (target) applyUpdate(target, update)
            return { acknowledged: true, matchedCount: target ? 1 : 0, modifiedCount: target ? 1 : 0 }
        },
        async updateMany(filter: any, update: any, opts?: any) {
            calls.updateMany.push({ filter, update, opts })
            const targets = docs.filter((d) => matches(d, filter))
            targets.forEach((d) => applyUpdate(d, update))
            return { acknowledged: true, matchedCount: targets.length, modifiedCount: targets.length }
        },
        async deleteOne(filter: any) {
            calls.deleteOne.push(filter)
            const i = docs.findIndex((d) => matches(d, filter))
            if (i >= 0) docs.splice(i, 1)
            return { acknowledged: true, deletedCount: i >= 0 ? 1 : 0 }
        },
        async deleteMany(filter: any = {}) {
            const before = docs.length
            for (let i = docs.length - 1; i >= 0; i--) if (matches(docs[i], filter)) docs.splice(i, 1)
            return { acknowledged: true, deletedCount: before - docs.length }
        },
        async countDocuments(filter: any = {}) {
            return docs.filter((d) => matches(d, filter)).length
        },
        aggregate(pipeline: any[]) {
            calls.aggregate.push(pipeline)
            return { toArray: async () => [{ pipeline }] }
        },
    }
    return collection
}

function createFakeDb() {
    const collections = new Map<string, ReturnType<typeof createFakeCollection>>()
    return {
        collections,
        collection(name: string) {
            if (!collections.has(name)) collections.set(name, createFakeCollection())
            return collections.get(name)!
        },
    }
}

type Order = { id: string; name: string; active: boolean; stock: number }

function makeOrders(defaults?: () => Partial<Order>) {
    const db = createFakeDb()
    const orders = new MongodbCollection<Order>(db as any, defineCollection<Order>({ collection: 'orders', defaults }))
    return { db, orders, raw: () => db.collection('orders') }
}

describe('MongodbCollection.create / insertMany', () => {
    test('strips input id/_id, sets timestamps, and returns a hydrated doc', async () => {
        const { orders, raw } = makeOrders()

        const created = await orders.create({ id: 'local:tmp', _id: 'nope', name: 'phone' } as any)

        // The doc handed to insertOne must NOT carry the client-supplied id/_id
        // (offline-first optimistic ids like 'local:...' must never be persisted).
        const snapshot = raw().insertSnapshots[0]
        expect(snapshot.hasId).toBe(false)
        expect(snapshot.hasRawId).toBe(false)
        expect(snapshot.keys.sort()).toEqual(['created_at', 'name', 'updated_at'])

        const stored = raw().docs[0]
        expect(stored._id).toBeInstanceOf(ObjectId) // a real ObjectId, not the input 'nope'
        expect(stored.name).toBe('phone')
        expect(typeof stored.created_at).toBe('number')
        expect(typeof stored.updated_at).toBe('number')

        // hydrated output exposes string id (not 'local:tmp'), hides _id
        expect(created.id).toBe(stored._id.toString())
        expect(created.id).not.toBe('local:tmp')
        expect((created as any)._id).toBe(stored._id) // readable internally
        expect(Object.keys(created)).toContain('id')
        expect(Object.keys(created)).not.toContain('_id')
    })

    test('JSON.stringify / spread expose id and omit _id and __v on hydrated docs', async () => {
        const { orders, raw } = makeOrders()
        // Simulate a doc previously written by Mongoose (carries _id + __v) and read back.
        raw().docs.push({ _id: new ObjectId(), name: 'phone', __v: 3 })

        const [found] = await orders.find()

        const json = JSON.parse(JSON.stringify(found))
        expect(json.id).toBe((found as any)._id.toString())
        expect(json._id).toBeUndefined()
        expect(json.__v).toBeUndefined() // would leak if hydrate relied on the (uncalled) toJSON
        expect(json.name).toBe('phone')

        const spread = { ...found } as any
        expect(spread.id).toBe((found as any)._id.toString())
        expect('_id' in spread).toBe(false)
        expect('__v' in spread).toBe(false)

        // The explicit toJSON() helper still works for direct callers.
        expect((found as any).toJSON().__v).toBeUndefined()
    })

    test('defaults resolver fills missing fields but input always wins', async () => {
        const { orders, raw } = makeOrders(() => ({ active: true, stock: 0 }))

        await orders.create({ name: 'phone', stock: 5 } as any)

        const stored = raw().docs[0]
        expect(stored.active).toBe(true) // from defaults
        expect(stored.stock).toBe(5) // input overrides default
        expect(stored.name).toBe('phone')
    })

    test('insertMany assigns ids and timestamps to every record', async () => {
        const { orders, raw } = makeOrders()

        const result = await orders.insertMany([{ name: 'a' }, { name: 'b' }] as any)

        expect(result).toHaveLength(2)
        expect(result[0].id).toBe(raw().docs[0]._id.toString())
        expect(result[1].id).toBe(raw().docs[1]._id.toString())
        expect(result[0].id).not.toBe(result[1].id)
        raw().docs.forEach((d) => expect(typeof d.created_at).toBe('number'))
    })
})

describe('MongodbCollection.find / findOne / findById / exists', () => {
    test('find and findOne hydrate results', async () => {
        const { orders } = makeOrders()
        await orders.create({ name: 'phone' } as any)

        const all = await orders.find()
        expect(all).toHaveLength(1)
        expect(all[0].id).toBeString()
        expect(Object.keys(all[0])).not.toContain('_id')

        const one = await orders.findOne({ name: 'phone' })
        expect(one?.name).toBe('phone')
    })

    test('findById / findOne(string) convert a 24-hex string to an _id ObjectId', async () => {
        const { orders, raw } = makeOrders()
        const hex = '507f1f77bcf86cd799439011'

        await orders.findById(hex)

        const { filter } = raw().calls.findOne[0]
        expect(filter._id).toBeInstanceOf(ObjectId)
        expect(filter._id.toString()).toBe(hex)
    })

    test('findOne(non-hex string) keeps the raw string as _id', async () => {
        const { orders, raw } = makeOrders()

        await orders.findOne('local:abc')

        expect(raw().calls.findOne[0].filter).toEqual({ _id: 'local:abc' })
    })

    test('exists returns a boolean and projects only _id', async () => {
        const { orders, raw } = makeOrders()
        const created = await orders.create({ name: 'phone' } as any)

        expect(await orders.exists(created.id)).toBe(true)
        expect(await orders.exists('507f1f77bcf86cd799439011')).toBe(false)
        expect(raw().calls.findOne.at(-1)?.opts).toEqual({ projection: { _id: 1 } })
    })
})

describe('MongodbCollection.updateOne / updateMany', () => {
    test('wraps a plain update in $set and bumps updated_at', async () => {
        const { orders, raw } = makeOrders()
        const created = await orders.create({ name: 'phone' } as any)

        await orders.updateOne(created.id, { name: 'new' })

        const { filter, update } = raw().calls.updateOne[0]
        expect(filter._id).toBeInstanceOf(ObjectId)
        expect(update.$set.name).toBe('new')
        expect(typeof update.$set.updated_at).toBe('number')
    })

    test('passes operator updates through and still bumps updated_at', async () => {
        const { orders, raw } = makeOrders()
        const created = await orders.create({ name: 'phone', stock: 1 } as any)

        await orders.updateOne(created.id, { $inc: { stock: 2 } })

        const { update } = raw().calls.updateOne[0]
        expect(update.$inc).toEqual({ stock: 2 })
        expect(typeof update.$set.updated_at).toBe('number')

        const after = await orders.findById(created.id)
        expect(after?.stock).toBe(3)
    })

    test('updateMany also wraps + touches', async () => {
        const { orders, raw } = makeOrders()
        await orders.create({ name: 'a', active: false } as any)
        await orders.create({ name: 'b', active: false } as any)

        await orders.updateMany({ active: false }, { active: true })

        const { update } = raw().calls.updateMany[0]
        expect(update.$set.active).toBe(true)
        expect(typeof update.$set.updated_at).toBe('number')
    })
})

describe('MongodbCollection.deleteOne / deleteMany / countDocuments / aggregate', () => {
    test('deleteOne converts a hex id to _id and removes the doc', async () => {
        const { orders, raw } = makeOrders()
        const created = await orders.create({ name: 'phone' } as any)

        await orders.deleteOne(created.id)

        expect(raw().calls.deleteOne[0]._id).toBeInstanceOf(ObjectId)
        expect(raw().docs).toHaveLength(0)
    })

    test('countDocuments and deleteMany operate over filters', async () => {
        const { orders } = makeOrders()
        await orders.create({ name: 'a', active: true } as any)
        await orders.create({ name: 'b', active: false } as any)

        expect(await orders.countDocuments()).toBe(2)
        expect(await orders.countDocuments({ active: true })).toBe(1)

        const { deletedCount } = await orders.deleteMany({ active: false })
        expect(deletedCount).toBe(1)
        expect(await orders.countDocuments()).toBe(1)
    })

    test('aggregate forwards the pipeline to the driver', async () => {
        const { orders, raw } = makeOrders()
        const pipeline = [{ $match: { active: true } }]

        const result = await orders.aggregate(pipeline)

        expect(raw().calls.aggregate[0]).toBe(pipeline)
        expect(result).toEqual([{ pipeline }])
    })
})
