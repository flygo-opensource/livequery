import { Cursor } from './Cursor.js'
import type {
    LivequeryContext,
    LivequeryDatasource as CoreLivequeryDatasource,
    LivequeryDatasourceInitConfig
} from '@livequery/core'
import type { LivequeryRequest, LivequeryBaseEntity, Paging, UpdatedData } from '@livequery/core'
import { MongoQuery } from "./MongoQuery.js";
import type { Collection, Db, MongoClient } from 'mongodb';
import { ObjectId } from 'mongodb';
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
}


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

        if (query.method == 'get') return await this.#get(query, collection)
        if (query.method == 'post') return this.#post(query, collection)
        if (query.method == 'put') return this.#put(query, collection)
        if (query.method == 'patch') return this.#patch(query, collection)
        if (query.method == 'delete') return this.#del(query, collection)
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

    async #get<T extends LivequeryBaseEntity>(req: LivequeryRequest<T>, collection: Collection<any>) {

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
                last: Cursor.caculate(items[items.length - 1] as T, req.query),
                first: Cursor.caculate(items[0] as T, req.query)
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

    async #post(req: LivequeryRequest, collection: Collection<any>) {
        const merged = {
            ...req.keys,
            ...req.body
        };
        const result = await collection.insertOne(merged);
        return {
            item: {
                ...merged,
                _id: undefined,
                id: result.insertedId.toString()
            }
        };
    }

    async #put(req: LivequeryRequest, collection: Collection<any>) {
        await collection.updateOne(this.#keys(req), this.#update(req.body))
        return { item: this.#writtenItem(req) }
    }

    async #patch(req: LivequeryRequest, collection: Collection<any>) {
        await collection.updateOne(this.#keys(req), this.#update(req.body))
        return { item: this.#writtenItem(req) }
    }

    async #del(req: LivequeryRequest, collection: Collection<any>) {
        await collection.deleteOne(this.#keys(req))
        return { item: this.#writtenItem(req) }
    }

    // Build the standard Livequery `{ id, ...data }` shape for a write response from the
    // request keys + body, instead of leaking the raw MongoDB UpdateResult/DeleteResult.
    // Operator bodies ($set/$inc/...) are not spread into the returned item.
    #writtenItem(req: LivequeryRequest) {
        const keys = req.keys || {}
        const isPlainBody = req.body && typeof req.body === 'object'
            && !Object.keys(req.body).some(k => k.startsWith('$'))
        const id = keys.id ?? req.document_id
        return {
            ...keys,
            ...isPlainBody ? req.body : {},
            ...id ? { id } : {}
        }
    }

    #keys(req: LivequeryRequest) {
        return Object.entries(req.keys).reduce((p, [k, c]) => {
            return {
                ...p,
                ...k == 'id' ? {
                    _id: this.#objectId('id', req.keys.id)
                } : {
                    [k]: c
                }
            }
        }, {} as { [key: string]: any })
    }

    // Validate + convert a hex string to an ObjectId, reporting which field is bad as
    // a 400 instead of letting bson throw an opaque 500.
    #objectId(field: string, value: unknown): ObjectId {
        if (typeof value != 'string' || !ObjectId.isValid(value)) {
            throw { status: 400, code: 'INVALID_OBJECT_ID', message: `Invalid ObjectId for field "${field}": ${JSON.stringify(value)}` }
        }
        return ObjectId.createFromHexString(value)
    }

    #update(body: any) {
        if (!body || Object.keys(body).some(key => key.startsWith('$'))) return body
        return { $set: body }
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
