import { MongoClient, type Db, type Collection } from 'mongodb'
import { AUTH_SOURCE, DB_NAME, MONGO_URL } from './env.js'

export type MongoHandle = {
    client: MongoClient
    db: Db
    close(): Promise<void>
}

export async function connectMongo(): Promise<MongoHandle> {
    const client = new MongoClient(MONGO_URL, {
        authSource: AUTH_SOURCE,
        serverSelectionTimeoutMS: 15000,
    })
    await client.connect()
    const db = client.db(DB_NAME)
    return {
        client,
        db,
        close: () => client.close().catch(() => undefined),
    }
}

export function uniqueCollection(prefix: string) {
    return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
}

export async function prepareCollection(db: Db, name: string): Promise<Collection<any>> {
    await db.createCollection(name).catch(() => undefined)
    const collection = db.collection(name)
    await collection.deleteMany({})
    return collection
}
