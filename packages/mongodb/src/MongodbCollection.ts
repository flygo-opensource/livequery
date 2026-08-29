import { ObjectId } from 'mongodb'
import type { Collection, Db, Filter } from 'mongodb'

// Normalize a native doc for output: expose `id` (= _id.toString()) as an ENUMERABLE
// field and hide `_id` / `__v` (NON-ENUMERABLE), so JSON.stringify / {...doc} / Object.keys
// all yield `id: string` with no `_id` / `__v`, while `doc._id` stays readable internally.
//
// NOTE: we hide fields via non-enumerability rather than via `toJSON`, because an OWN
// non-enumerable `toJSON` is NOT honored by `JSON.stringify` (only enumerable-own or
// prototype `toJSON` is). The `toJSON` below is kept only for callers that invoke it
// directly; serialization correctness comes entirely from the enumerability flags.
function hydrate<T extends Record<string, any>>(doc: T | null): T | null {
    if (!doc) return null
    const oid = (doc as any)._id
    Object.defineProperty(doc, '_id', { value: oid, enumerable: false, configurable: true, writable: true })
    if (Object.prototype.hasOwnProperty.call(doc, '__v')) {
        Object.defineProperty(doc, '__v', { value: (doc as any).__v, enumerable: false, configurable: true, writable: true })
    }
    Object.defineProperty(doc, 'id', {
        value: oid ? oid.toString() : undefined,
        enumerable: true,
        configurable: true,
        writable: true,
    })
    Object.defineProperty(doc, 'toJSON', {
        value(this: any) {
            const { _id: _omitId, __v: _omitV, ...rest } = this
            return rest
        },
        enumerable: false,
        configurable: true,
    })
    return doc
}

// Mongoose updateOne(filter, { a: 1 }) auto-wraps in $set; the native driver requires an
// operator. Pass through when the update already uses a $-operator, else wrap in $set.
function withSet(update: Record<string, any>) {
    const hasOperator = Object.keys(update || {}).some((k) => k.startsWith('$'))
    return hasOperator ? update : { $set: update }
}

// Bump `updated_at` on every update (mongoose timestamps:true style): merge into the $set
// branch without disturbing other operators ($inc/$push/...).
function withTouch(update: Record<string, any>) {
    const base = withSet(update) as Record<string, any>
    return { ...base, $set: { ...(base.$set ?? {}), updated_at: Date.now() } }
}

// findOne/findById/updateOne/deleteOne accept string id | ObjectId | object filter.
// A 24-hex string -> { _id: ObjectId }; an ObjectId -> { _id }; any other string/object stays as-is.
function isHex24(s: string) {
    return /^[a-f\d]{24}$/i.test(s)
}
function toFilter(filter: string | ObjectId | Filter<any> = {}): Filter<any> {
    if (typeof filter === 'string') return { _id: isHex24(filter) ? ObjectId.createFromHexString(filter) : filter } as any
    if (filter instanceof ObjectId) return { _id: filter } as any
    return filter as Filter<any>
}

export type MongoDoc<T> = T & { id: string; toJSON(): any }

// Collection-level default resolver — a replacement for mongoose `@Prop({ default })`.
// Receives the input doc and returns default fields; the input always overrides defaults.
// e.g. () => ({ started: false, running: true }).
export type DefaultsResolver<T> = (input: Partial<T>) => Partial<T>

export class CollectionDef<T> {
    // Phantom field so TypeScript preserves T for inference (never set at runtime).
    declare readonly _type: T
    constructor(
        readonly collection: string,
        readonly defaults?: DefaultsResolver<T>,
    ) {}
}

// defineCollection<Order>({ collection: 'orders', defaults: () => ({ active: true }) })
export function defineCollection<T>(config: {
    collection: string
    defaults?: DefaultsResolver<T>
}): CollectionDef<T> {
    return new CollectionDef(config.collection, config.defaults)
}

// A mongoose.Model-like CRUD wrapper over the native MongoDB driver, complementing
// MongoDatasource (livequery query engine) for plain imperative access.
//  - new MongodbCollection(db, defineCollection<Order>({ collection: 'orders' }))
//  - find/findOne/create/insertMany return hydrated docs (id:string, no _id)
//  - findOne/findById/updateOne/deleteOne accept string id | ObjectId | object
//  - updateOne/updateMany wrap $set and bump updated_at
//  - create/insertMany set created_at/updated_at + apply the defaults resolver (input id/_id are never persisted)
export class MongodbCollection<T = any> {
    private readonly collectionName: string
    private readonly resolveDefaults?: DefaultsResolver<T>

    constructor(
        private readonly db: Db,
        config: CollectionDef<T>,
    ) {
        this.collectionName = config.collection
        this.resolveDefaults = config.defaults
    }

    // Lazy raw collection — does not depend on connect order.
    get collection(): Collection<any> {
        return this.db.collection<any>(this.collectionName)
    }

    // Build an insert payload: timestamps + resolver defaults + input (input wins); strip input id/_id.
    private prepareInsert(input: Partial<T>): any {
        const now = Date.now()
        const { id: _gid, _id: _moid, ...clean } = (input ?? {}) as any
        const defaults = this.resolveDefaults ? this.resolveDefaults((input ?? {}) as Partial<T>) : {}
        return { created_at: now, updated_at: now, ...defaults, ...clean }
    }

    async find(filter: Filter<any> = {}): Promise<MongoDoc<T>[]> {
        const docs = await this.collection.find(filter).toArray()
        return docs.map((d) => hydrate(d)!) as any
    }

    async findOne(filter: string | ObjectId | Filter<any> = {}): Promise<MongoDoc<T> | null> {
        return hydrate(await this.collection.findOne(toFilter(filter))) as any
    }

    findById(id: string | ObjectId): Promise<MongoDoc<T> | null> {
        return this.findOne(id)
    }

    async create(doc: Partial<T>): Promise<MongoDoc<T>> {
        const record = this.prepareInsert(doc)
        const r = await this.collection.insertOne(record)
        record._id = r.insertedId
        return hydrate(record) as any
    }

    async insertMany(docs: Partial<T>[]): Promise<MongoDoc<T>[]> {
        const records = docs.map((d) => this.prepareInsert(d))
        const r = await this.collection.insertMany(records)
        records.forEach((d, i) => (d._id = r.insertedIds[i]))
        return records.map((d) => hydrate(d)!) as any
    }

    updateOne(filter: string | ObjectId | Filter<any>, update: any, opts?: any) {
        return this.collection.updateOne(toFilter(filter), withTouch(update), opts)
    }

    updateMany(filter: Filter<any>, update: any, opts?: any) {
        return this.collection.updateMany(filter, withTouch(update), opts)
    }

    deleteOne(filter: string | ObjectId | Filter<any>) {
        return this.collection.deleteOne(toFilter(filter))
    }

    deleteMany(filter: Filter<any> = {}) {
        return this.collection.deleteMany(filter)
    }

    countDocuments(filter: Filter<any> = {}) {
        return this.collection.countDocuments(filter)
    }

    exists(filter: string | ObjectId | Filter<any> = {}): Promise<boolean> {
        return this.collection.findOne(toFilter(filter), { projection: { _id: 1 } }).then((d) => !!d)
    }

    aggregate<R = any>(pipeline: any[]): Promise<R[]> {
        return this.collection.aggregate(pipeline).toArray() as Promise<R[]>
    }
}
