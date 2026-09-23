import { ObjectId } from 'mongodb'

type AggregateResponse = any[]

export type MockCollection = {
    name: string
    aggregateCalls: any[][]
    insertOneCalls: any[]
    updateOneCalls: Array<{ filter: any, update: any }>
    deleteOneCalls: any[]
    findOneAndUpdateCalls: Array<{ filter: any, update: any, options: any }>
    /** What `findOneAndUpdate` answers; a pipeline `$set` of `$$NOW` shows as this clock. */
    dbNow: number
    /** Makes conditional writes match nothing, and `findOne` answer this document. */
    stored: Record<string, any> | null
    aggregateResponse: AggregateResponse
    aggregate: (pipeline: any[]) => { toArray: () => Promise<any[]> }
    insertOne: (doc: any) => Promise<{ insertedId: ObjectId }>
    updateOne: (filter: any, update: any) => Promise<{ acknowledged: boolean, matchedCount: number, modifiedCount: number }>
    deleteOne: (filter: any) => Promise<{ acknowledged: boolean, deletedCount: number }>
    findOneAndUpdate: (filter: any, update: any, options?: any) => Promise<any>
    findOne: (filter: any, options?: any) => Promise<any>
}

export function createMockCollection(name = 'items', aggregateResponse: AggregateResponse = []) {
    const collection: MockCollection = {
        name,
        aggregateCalls: [],
        insertOneCalls: [],
        updateOneCalls: [],
        deleteOneCalls: [],
        findOneAndUpdateCalls: [],
        dbNow: 1_790_000_000_000,
        stored: null,
        aggregateResponse,
        aggregate(pipeline: any[]) {
            collection.aggregateCalls.push(pipeline)
            return {
                toArray: async () => collection.aggregateResponse,
            }
        },
        async insertOne(doc: any) {
            collection.insertOneCalls.push(doc)
            return { insertedId: new ObjectId('507f1f77bcf86cd799439011') }
        },
        async updateOne(filter: any, update: any) {
            collection.updateOneCalls.push({ filter, update })
            return { acknowledged: true, matchedCount: 1, modifiedCount: 1 }
        },
        // Applies a pipeline's `$set` stages to `{ _id }`: literals unwrapped, `$$NOW` as dbNow.
        async findOneAndUpdate(filter: any, update: any, options: any = {}) {
            collection.findOneAndUpdateCalls.push({ filter, update, options })
            if (collection.stored && !options.upsert) return null
            const doc: Record<string, any> = { _id: filter._id ?? new ObjectId('507f1f77bcf86cd799439011') }
            for (const stage of Array.isArray(update) ? update : []) {
                for (const [key, value] of Object.entries(stage.$set ?? {})) {
                    doc[key] = (value as any)?.$literal !== undefined ? (value as any).$literal
                        : JSON.stringify(value) === JSON.stringify({ $toLong: '$$NOW' }) ? collection.dbNow : value
                }
            }
            return doc
        },
        async findOne() {
            return collection.stored
        },
        async deleteOne(filter: any) {
            collection.deleteOneCalls.push(filter)
            return { acknowledged: true, deletedCount: 1 }
        },
    }

    return collection
}

export function createMockDb(collections: Record<string, MockCollection>) {
    return {
        collectionCalls: [] as string[],
        collection(name: string) {
            this.collectionCalls.push(name)
            const collection = collections[name]
            if (!collection) throw new Error(`Missing mock collection "${name}"`)
            return collection
        },
    }
}

export function createMockClient(databases: Record<string, ReturnType<typeof createMockDb>>) {
    return {
        dbCalls: [] as string[],
        db(name: string) {
            this.dbCalls.push(name)
            const db = databases[name]
            if (!db) throw new Error(`Missing mock db "${name}"`)
            return db
        },
    }
}

export function collectionReadResponse(items: any[] = []) {
    return [{
        items,
        count: { next: 0, prev: 0 },
        has: { next: false, prev: false },
        summary: {},
    }]
}

export function baseRequest(overrides: Record<string, any> = {}) {
    return {
        method: 'get',
        ref: 'items',
        is_collection: true,
        keys: {},
        query: {},
        ...overrides,
    }
}
