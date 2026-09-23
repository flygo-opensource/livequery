import type { ClientSession, Db } from 'mongodb'

// One counter document per collection: `{ _id: <collection>, v: <last version> }`.
const VERSIONS = '__livequery_versions'
// MongoDB's own clock, in ms (4.2+).
const DB_NOW = { $toLong: '$$NOW' }
// Deployments without transactions (a standalone server) were already warned about.
const warned = new Set<Db>()
const created = new WeakSet<Db>()

/**
 * Run a write with the next version of `collection`, in one transaction: the version is
 * `max(database clock in ms, previous version + 1)`, so it reads like a timestamp and never repeats.
 *
 * Every write of a collection increments the same counter, and a transaction cannot touch it until
 * the one before has committed — so versions are handed out in commit order. A client that has read
 * everything up to version N can ask for "after N" and miss nothing, even a write that took long to
 * commit. Pass `session` to every operation inside `write`; it may run more than once (the driver
 * retries a transaction that collided with another).
 *
 *     await withVersion(db, 'chats', (version, session) =>
 *         db.collection('chats').updateOne({ _id }, { $set: { title, updated_at: version } }, { session }))
 *
 * Needs a replica set, as change streams do. On a standalone server it warns once and runs without
 * the transaction: versions still increase, but no longer in commit order.
 */
export async function withVersion<T>(db: Db, collection: string, write: (version: number, session: ClientSession | undefined) => Promise<T>): Promise<T> {
    if (!created.has(db)) {
        // Collections are not always creatable inside a transaction.
        await db.createCollection(VERSIONS).catch(() => undefined)
        created.add(db)
    }
    const next = async (session?: ClientSession) => {
        const counter = await db.collection<{ _id: string, v: number }>(VERSIONS).findOneAndUpdate(
            { _id: collection },
            [{ $set: { v: { $max: [DB_NOW, { $add: [{ $ifNull: ['$v', 0] }, 1] }] } } }],
            { upsert: true, returnDocument: 'after', ...session ? { session } : {} },
        )
        return counter!.v
    }
    if (warned.has(db)) return await write(await next(), undefined)

    const session = db.client.startSession()
    try {
        return await session.withTransaction(async () => write(await next(session), session))
    } catch (e: any) {
        // "Transaction numbers are only allowed on a replica set member or mongos".
        if (e?.code !== 20 && !/replica set|Transaction numbers/i.test(String(e?.message))) throw e
        warned.add(db)
        console.warn('livequery: MongoDB has no transactions (standalone server); sync versions are not in commit order')
        return await write(await next(), undefined)
    } finally {
        await session.endSession()
    }
}
