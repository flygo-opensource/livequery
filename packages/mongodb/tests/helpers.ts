import { ObjectId } from 'bson'

type AggregateResponse = any[]

export type MockCollection = {
    name: string
    aggregateCalls: any[][]
    insertOneCalls: any[]
    updateOneCalls: Array<{ filter: any, update: any }>
    deleteOneCalls: any[]
    aggregateResponse: AggregateResponse
    aggregate: (pipeline: any[]) => { toArray: () => Promise<any[]> }
    insertOne: (doc: any) => Promise<{ insertedId: ObjectId }>
    updateOne: (filter: any, update: any) => Promise<{ acknowledged: boolean, matchedCount: number, modifiedCount: number }>
    deleteOne: (filter: any) => Promise<{ acknowledged: boolean, deletedCount: number }>
}

export function createMockCollection(name = 'items', aggregateResponse: AggregateResponse = []) {
    const collection: MockCollection = {
        name,
        aggregateCalls: [],
        insertOneCalls: [],
        updateOneCalls: [],
        deleteOneCalls: [],
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
        options: {},
        ...overrides,
    }
}
