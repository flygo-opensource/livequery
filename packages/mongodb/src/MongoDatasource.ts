import { Cursor } from './Cursor.js'
import type {
    LivequeryContext,
    LivequeryDatasource as CoreLivequeryDatasource,
    LivequeryDatasourceInitConfig
} from '@livequery/core'
import type { LivequeryRequest, LivequeryBaseEntity, Paging, WebsocketSyncPayload } from './types.js'
import { MongoQuery } from "./MongoQuery.js";
import type { Collection, Db, MongoClient } from 'mongodb';
import { ObjectId } from 'bson';
import { SmartCache } from './SmartCache.js';
import { Subject } from 'rxjs';


export type LivequeryDatasource<Config, RouteOptions> = Subject<WebsocketSyncPayload<LivequeryBaseEntity>> & {
    init(config: Config, routes: Array<{ path: string, method: number, options: RouteOptions }>): Promise<void>
    query: (query: LivequeryRequest, options: RouteOptions) => Promise<any>
}

export type MongoConnection = MongoClient | Db

export type MongoDatasourceConfig = {
    connections: { [key: string]: MongoConnection },
    databases?: string[]
}

type LegacyRouteConfig<RouteOptions> = {
    path: string
    method: number | string
    options?: RouteOptions
    config?: RouteOptions
}

export type RouteOptions = {
    realtime?: boolean
    collection: string | ((req: LivequeryRequest) => Promise<string> | string),
    db?: string | ((req: LivequeryRequest) => Promise<string> | string),
    connection?: string | ((req: LivequeryRequest) => Promise<string> | string),
    objectIdFields?: string[]
}


export class MongoDatasource extends Subject<WebsocketSyncPayload<LivequeryBaseEntity>> implements LivequeryDatasource<MongoDatasourceConfig, RouteOptions>, CoreLivequeryDatasource<RouteOptions> {

    #collections = new SmartCache()
    public readonly refs = new Map<string, Set<string>>()

    config: MongoDatasourceConfig
    routes: Map<string, RouteOptions>
    constructor(config?: MongoDatasourceConfig) {
        super()
        if (config) this.config = config
        this.routes = new Map()
    }

    async init(routes: Array<LivequeryDatasourceInitConfig<RouteOptions>>): Promise<void>
    async init(config: MongoDatasourceConfig, routes: Array<LegacyRouteConfig<RouteOptions>>): Promise<void>
    async init(
        configOrRoutes: MongoDatasourceConfig | Array<LivequeryDatasourceInitConfig<RouteOptions>>,
        maybeRoutes?: Array<LegacyRouteConfig<RouteOptions>>
    ): Promise<void> {
        const routes = Array.isArray(configOrRoutes)
            ? configOrRoutes
            : maybeRoutes || []

        if (!Array.isArray(configOrRoutes)) {
            this.config = configOrRoutes
        }

        this.routes = routes.reduce((p, c) => {
            const options = this.#getRouteOptions(c)
            if (!options.collection) return p

            const key = this.#routeKey(c.method, c.path)
            const set = p.get(key) || p.get(c.path)
            if (set && set.collection != options.collection) throw new Error('Collection mismatch for route path "' + c.path + '"')
            p.set(key, options)
            p.set(c.path, options)
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

    #getRouteOptions(route: LegacyRouteConfig<RouteOptions> | LivequeryDatasourceInitConfig<RouteOptions>) {
        const legacy = route as LegacyRouteConfig<RouteOptions>
        if (legacy.options) return legacy.options
        if (legacy.config) return legacy.config

        const { method, path, ...options } = route as LivequeryDatasourceInitConfig<RouteOptions>
        return options as RouteOptions
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
            doc_id: livequery.document_id,
            keys: livequery.keys || {},
            query: livequery.query || {},
            options: livequery.query || {},
            method: livequery.method?.toLowerCase(),
            body: livequery.body,
        }
    }

    #normalizeRequest(req: LivequeryRequest): LivequeryRequest {
        const options = req.options || req.query || {}
        return {
            ...req,
            keys: req.keys || {},
            query: req.query || options,
            options,
            is_collection: typeof req.is_collection == 'boolean' ? req.is_collection : !req.document_id,
            doc_id: req.doc_id || req.document_id,
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
                last: Cursor.caculate(items[items.length - 1] as T, req.options),
                first: Cursor.caculate(items[0] as T, req.options)
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
        return await collection.updateOne(this.#keys(req), this.#update(req.body))
    }

    async #patch(req: LivequeryRequest, collection: Collection<any>) {
        return await collection.updateOne(this.#keys(req), this.#update(req.body))
    }

    async #del(req: LivequeryRequest, collection: Collection<any>) {
        return await collection.deleteOne(this.#keys(req))
    }

    #keys(req: LivequeryRequest) {
        return Object.entries(req.keys).reduce((p, [k, c]) => {
            return {
                ...p,
                ...k == 'id' ? {
                    _id: ObjectId.createFromHexString(req.keys.id)
                } : {
                    [k]: c
                }
            }
        }, {} as { [key: string]: any })
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
