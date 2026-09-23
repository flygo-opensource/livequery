import { Cursor } from './Cursor.js'
import type {
    LivequeryContext,
    LivequeryDatasource as CoreLivequeryDatasource,
    LivequeryDatasourceInitConfig
} from '@livequery/core'
import type { LivequeryRequest, LivequeryBaseEntity, Paging, UpdatedData } from '@livequery/core'
import { ID_ALREADY_EXISTS, resolveClientId } from '@livequery/core'
import { MongoQuery } from "./MongoQuery.js";
import type { Collection, Db, MongoClient } from 'mongodb';
import { Binary, ObjectId, UUID } from 'mongodb';
import { fromMongoId, toMongoId } from './helpers/index.js';
import { SmartCache } from './SmartCache.js';
import { Subject } from 'rxjs';


export type MongoConnection = MongoClient | Db

export type MongoDatasourceConfig = {
    connections: { [key: string]: MongoConnection },
    databases?: string[]
}

export type RouteOptions = {
    realtime?: boolean
    collection: string | ((req: LivequeryRequest) => Promise<string> | string),
    db?: string | ((req: LivequeryRequest) => Promise<string> | string),
    connection?: string | ((req: LivequeryRequest) => Promise<string> | string),
    objectIdFields?: string[]
    /**
     * Accept the id a client sends on add (a uuidv7, stored as a BSON UUID `_id`), so a retried
     * add cannot create a second document. Default true; false ignores it and lets MongoDB assign
     * an ObjectId, as before 3.0.
     */
    clientIds?: boolean
    /**
     * Serve local-first sync (`mode: { scope: ... }` on the client): every write stamps
     * `updated_at` (ms), a delete keeps the document as a tombstone with `deleted_at`, reads hide
     * tombstones, and a delta read (`updated_at:gt` + `:tombstones`) returns them so devices that
     * were offline learn about deletes.
     */
    sync?: boolean
}

// Hidden unless a read asks for them.
const LIVE = { deleted_at: null }

// Versions come from the database's clock (ms), not from whichever server process wrote: every
// instance then stamps from one clock. Needs MongoDB 4.2+.
const DB_NOW = { $toLong: '$$NOW' }
// Set only in an insert's filter, so an existing document never matches it (see `#insertVersioned`).
const INSERTING = '__livequery_inserting'
// Pipeline stages read `$field` strings as paths: data goes in as literals.
const literals = (fields: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { $literal: value }]))
const isPlainBody = (body: unknown): body is Record<string, unknown> =>
    !!body && typeof body === 'object' && !Object.keys(body).some(key => key.startsWith('$'))


export class MongoDatasource extends Subject<UpdatedData<LivequeryBaseEntity>> implements CoreLivequeryDatasource<RouteOptions> {

    #collections = new SmartCache()
    public readonly refs = new Map<string, Set<string>>()

    config: MongoDatasourceConfig
    routes: Map<string, RouteOptions>
    constructor(config?: MongoDatasourceConfig) {
        super()
        if (config) this.config = config
        this.routes = new Map()
    }

    async init(routes: Array<LivequeryDatasourceInitConfig<RouteOptions>>): Promise<void> {
        this.routes = routes.reduce((p, c) => {
            const { method, path, ...options } = c
            const routeOptions = options as RouteOptions
            if (!routeOptions.collection) return p

            const key = this.#routeKey(c.method, c.path)
            const set = p.get(key) || p.get(c.path)
            if (set && set.collection != routeOptions.collection) throw new Error('Collection mismatch for route path "' + c.path + '"')
            p.set(key, routeOptions)
            p.set(c.path, routeOptions)
            return p
        }, new Map<string, RouteOptions>())
    }

    async handle(ctx: LivequeryContext) {
        const request = this.#toLivequeryRequest(ctx)
        if (!request) throw { status: 400, code: 'INVALID_LIVEQUERY_REQUEST', message: 'Invalid livequery request' }

        const options = this.#getOptions(ctx)
        ctx.response = await this.query(request, options)
        return ctx.response
    }

    async query(req: LivequeryRequest, options: RouteOptions) {
        if (!this.config) throw { status: 500, code: 'DB_CONFIG_NOT_FOUND', message: 'Database config not found' }
        const collection = await this.#getCollection(req, options)
        const query = this.#normalizeObjectIds(this.#normalizeRequest(req), options.objectIdFields || [])

        if (query.method == 'get') return await this.#get(query, collection, options)
        if (query.method == 'post') return this.#post(query, collection, options)
        if (query.method == 'put') return this.#put(query, collection, options)
        if (query.method == 'patch') return this.#put(query, collection, options)
        if (query.method == 'delete') return this.#del(query, collection, options)
        throw { status: 500, code: 'INVAILD_METHOD', message: 'Invaild method' }
    }

    #getOptions(ctx: LivequeryContext) {
        const routePath = ctx.request.ref || ctx.request.path
        const options = this.routes.get(this.#routeKey(ctx.request.method, routePath)) || this.routes.get(routePath)
        if (!options) throw { status: 404, code: 'ROUTE_OPTIONS_NOT_FOUND', message: `Route options for "${routePath}" not found` }
        return options
    }

    #routeKey(method: string | number, path: string) {
        return `${String(method).toUpperCase()} ${path}`
    }

    #toLivequeryRequest(ctx: LivequeryContext): LivequeryRequest | undefined {
        const livequery = ctx.livequery
        if (!livequery) return undefined

        return {
            ref: livequery.ref,
            is_collection: !livequery.document_id,
            collection_ref: livequery.collection_ref,
            schema_collection_ref: livequery.schema_collection_ref,
            document_id: livequery.document_id,
            keys: livequery.keys || {},
            query: livequery.query || {},
            method: livequery.method?.toLowerCase(),
            body: livequery.body,
        }
    }

    #normalizeRequest(req: LivequeryRequest): LivequeryRequest {
        const query = req.query || {}
        return {
            ...req,
            keys: req.keys || {},
            query,
            is_collection: typeof req.is_collection == 'boolean' ? req.is_collection : !req.document_id,
            method: req.method?.toLowerCase(),
        }
    }

    async #getCollection(req: LivequeryRequest, options: RouteOptions): Promise<Collection<any>> {
        const connectionName = typeof options.connection == 'function' ? await options.connection(req) : (options.connection || Object.keys(this.config.connections)[0] || 'default')
        const dbName = typeof options.db == 'function' ? await options.db(req) : (options.db || process.env.DB_NAME! || 'main')
        const collectionName = typeof options.collection == 'function' ? await options.collection(req) : options.collection

        return await this.#collections.get(`${connectionName}|${dbName}|${collectionName}`, async () => {
            const connection = this.config.connections[connectionName]
            if (!connection) throw { status: 500, code: 'DB_CONNECTION_NOT_FOUND', message: `Database connection "${connectionName}" not found` }
            const db = this.#isDb(connection) ? connection : connection.db(dbName)
            return db.collection(collectionName)
        })
    }

    #isDb(connection: MongoConnection): connection is Db {
        return typeof (connection as Db).collection == 'function'
    }

    async #get<T extends LivequeryBaseEntity>(req: LivequeryRequest<T>, collection: Collection<any>, options: RouteOptions) {
        if (options.sync && !req.query?.[':tombstones']) req = { ...req, keys: { ...req.keys, ...LIVE } as any }

        const {
            limit,
            items,
            count,
            has,
            summary
        } = await MongoQuery.query(req, collection)


        const current = items.length
        const total = current + count.next + count.prev
        const paging: Paging = {

            cursor: {
                last: Cursor.caculate(items[items.length - 1] as T, req.query || {}),
                first: Cursor.caculate(items[0] as T, req.query || {})
            },
            has,
            count: {
                ...count,
                current,
                total
            },
            page: {
                current: Math.floor(count.prev / limit + 1),
                total: Math.ceil(total / limit)
            }
        }


        if (req.is_collection) {
            const data = {
                ...paging,
                items,
                summary,
            };
            return data;
        }
        const item = items[0]
        return {
            summary,
            ...paging,
            "has": {
                "prev": false,
                "next": false
            },
            "count": {
                "prev": 0,
                "next": 0,
                "current": item ? 1 : 0,
                "total": item ? 1 : 0
            },
            "page": {
                "current": item ? 1 : 0,
                "total": item ? 1 : 0
            },
            item,
        };

    }

    async #post(req: LivequeryRequest, collection: Collection<any>, options: RouteOptions) {
        const client_id = options.clientIds === false ? undefined : resolveClientId(req.body)
        const { id: _bodyId, _id: _bodyRawId, ...cleanBody } = req.body || {}
        const merged = {
            ...req.keys,
            ...cleanBody,
            ...client_id ? { _id: new UUID(client_id) } : {}
        };
        const inserted = options.sync ? this.#insertVersioned(collection, merged) : collection.insertOne(merged).then(r => ({ ...merged, _id: r.insertedId }))
        const stored = await inserted.catch(e => {
            if (e?.code !== 11000) throw e
            // A retried add finds its own first attempt here; the client treats the 409 as
            // "already created" and sends what changed since as an update.
            if (e?.keyPattern?._id) {
                throw { status: 409, code: ID_ALREADY_EXISTS, message: `A document with id ${client_id} already exists` }
            }
            throw { status: 409, code: 'DUPLICATE_KEY', message: `Duplicate value for unique index ${JSON.stringify(e?.keyPattern ?? {})}` }
        });
        return {
            item: this.#stringifyOids({
                ...stored,
                _id: undefined,
                id: fromMongoId(stored._id)
            })
        };
    }

    // An insert whose `updated_at` is the database's clock: an upsert whose filter no existing
    // document can match, so an `_id` already taken still fails with a duplicate key (11000).
    async #insertVersioned(collection: Collection<any>, doc: Record<string, any>) {
        const { _id = new ObjectId(), ...fields } = doc
        const stored = await collection.findOneAndUpdate(
            { _id, [INSERTING]: true },
            [{ $set: { ...literals(fields), updated_at: DB_NOW } }, { $unset: INSERTING }],
            { upsert: true, returnDocument: 'after' },
        )
        return stored as Record<string, any> & { _id: unknown }
    }

    async #put(req: LivequeryRequest, collection: Collection<any>, options: RouteOptions) {
        if (!options.sync) {
            await collection.updateOne(this.#keys(req), this.#update(req.body))
            return { item: this.#writtenItem(req) }
        }
        // A tombstone stays deleted: an update racing a delete must not bring it back.
        const filter = { ...this.#keys(req), ...LIVE }
        if (!isPlainBody(req.body)) {
            // Operators ($inc, $push…) cannot run in a pipeline: this one is stamped by the server.
            const updated_at = Date.now()
            const update = this.#update(req.body) ?? {}
            await collection.updateOne(filter, { ...update, $set: { ...update.$set, updated_at } })
            return { item: { ...this.#writtenItem(req), updated_at } }
        }
        const { id: _id, _id: _raw_id, ...fields } = req.body
        const stored = await collection.findOneAndUpdate(
            filter,
            [{ $set: { ...literals(fields), updated_at: DB_NOW } }],
            { returnDocument: 'after', projection: { updated_at: 1 } },
        )
        return { item: { ...this.#writtenItem(req), ...stored ? { updated_at: stored.updated_at } : {} } }
    }

    async #del(req: LivequeryRequest, collection: Collection<any>, options: RouteOptions) {
        if (!options.sync) {
            await collection.deleteOne(this.#keys(req))
            return { item: this.#writtenItem(req) }
        }
        const stored = await collection.findOneAndUpdate(
            { ...this.#keys(req), ...LIVE },
            [{ $set: { deleted_at: DB_NOW, updated_at: DB_NOW } }],
            { returnDocument: 'after', projection: { deleted_at: 1, updated_at: 1 } },
        )
        return { item: { ...this.#writtenItem(req), ...stored ? { deleted_at: stored.deleted_at, updated_at: stored.updated_at } : {} } }
    }

    // Build the standard Livequery `{ id, ...data }` shape for a write response from the
    // request keys + body, instead of leaking the raw MongoDB UpdateResult/DeleteResult.
    // Operator bodies ($set/$inc/...) are not spread into the returned item.
    #writtenItem(req: LivequeryRequest) {
        const keys = req.keys || {}
        const isPlainBody = req.body && typeof req.body === 'object'
            && !Object.keys(req.body).some(k => k.startsWith('$'))
        const id = keys.id ?? req.document_id
        return this.#stringifyOids({
            ...keys,
            ...isPlainBody ? req.body : {},
            ...id ? { id } : {}
        })
    }

    // objectIdFields converts top-level keys/body to ObjectId instances before the write.
    // Convert them back to hex strings for the API response so the returned item matches the
    // string shape clients send (and that `id` already uses), instead of leaking ObjectId.
    #stringifyOids(item: Record<string, any>) {
        return Object.entries(item).reduce((p, [k, v]) => {
            const is_id = v instanceof ObjectId || (v instanceof Binary && v.sub_type === Binary.SUBTYPE_UUID)
            return { ...p, [k]: is_id ? fromMongoId(v) : v }
        }, {} as Record<string, any>)
    }

    #keys(req: LivequeryRequest) {
        return Object.entries(req.keys).reduce((p, [k, c]) => {
            return {
                ...p,
                ...k == 'id' ? {
                    _id: toMongoId('id', req.keys.id)
                } : {
                    [k]: c
                }
            }
        }, {} as { [key: string]: any })
    }

    #update(body: any) {
        if (!body || Object.keys(body).some(key => key.startsWith('$'))) return body
        const { id: _id, _id: _rawId, ...cleanBody } = body
        return { $set: cleanBody }
    }

    #convert(obj: any, fields: Set<string>) {
        return {
            ...obj,
            ...[...fields].reduce((p, c) => {
                if (obj[c] && typeof obj[c] == 'string' && ObjectId.isValid(obj[c])) {
                    return {
                        ...p,
                        [c]: ObjectId.createFromHexString(obj[c])
                    }
                }
                return p
            }, {} as { [key: string]: any })
        }
    }

    #normalizeObjectIds(req: LivequeryRequest, fields: string[]) {
        const objectIdFields = new Set(fields)

        if (objectIdFields.size == 0) return req

        return {
            ...req,
            ...req.keys ? { keys: this.#convert(req.keys, objectIdFields) } : {},
            ...req.body ? { body: this.#convert(req.body, objectIdFields) } : {}
        } as LivequeryRequest
    }

}
