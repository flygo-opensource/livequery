import {
    hidePrivateFields,
    ID_ALREADY_EXISTS,
    resolveClientId,
    type LivequeryContext,
    type LivequeryDatasource as CoreLivequeryDatasource,
    type LivequeryDatasourceInitConfig,
    type LivequeryRequest,
} from '@livequery/core'
import { D1Query } from './D1Query.js'
import type { D1CollectionResult, D1DatasourceConfig, D1RouteOptions } from './types.js'

type D1Entity = { id: string }
type D1ItemResult<T extends D1Entity> = { item: T }
type D1DatasourceResult<T extends D1Entity> = D1CollectionResult<T> | D1ItemResult<T>

/**
 * Maps Livequery requests onto Cloudflare D1.
 *
 * The two-argument `query(request, options)` and one-argument `handle(context)`
 * methods implement the core datasource contract. The overloads that accept a
 * D1 binding directly are retained for Workers that obtain `env.DB` per request.
 */
export class D1Datasource implements CoreLivequeryDatasource<D1RouteOptions> {
    config?: D1DatasourceConfig
    routes: Map<string, D1RouteOptions>

    constructor(config?: D1DatasourceConfig) {
        this.config = config
        this.routes = new Map()
    }

    async init(routes: Array<LivequeryDatasourceInitConfig<D1RouteOptions>>): Promise<void> {
        this.routes = routes.reduce((mapped, route) => {
            const { method, path, ...options } = route
            const routeOptions = options as D1RouteOptions
            if (!routeOptions.table) return mapped

            const key = this.#routeKey(method, path)
            const existing = mapped.get(key) || mapped.get(path)
            if (existing && existing.table !== routeOptions.table) {
                throw new Error(`Table mismatch for route path "${path}"`)
            }

            mapped.set(key, routeOptions)
            // Retain the path-only lookup used by the other datasource adapters.
            mapped.set(path, routeOptions)
            return mapped
        }, new Map<string, D1RouteOptions>())
    }

    async handle(ctx: LivequeryContext): Promise<unknown>
    async handle<T extends D1Entity>(
        db: D1Database,
        req: LivequeryRequest | undefined,
        options: D1RouteOptions
    ): Promise<D1DatasourceResult<T>>
    async handle<T extends D1Entity>(
        ctxOrDb: LivequeryContext | D1Database,
        req?: LivequeryRequest,
        options?: D1RouteOptions
    ): Promise<unknown> {
        if (this.#isD1Database(ctxOrDb)) {
            if (!req || !options) {
                throw { status: 400, code: 'INVALID_REQUEST', message: 'Invalid livequery request' }
            }
            return this.#dispatch<T>(ctxOrDb, this.#normalizeRequest(req), options, true)
        }

        const request = this.#toLivequeryRequest(ctxOrDb)
        if (!request) {
            throw {
                status: 400,
                code: 'INVALID_LIVEQUERY_REQUEST',
                message: 'Invalid livequery request',
            }
        }

        const routeOptions = this.#getOptions(ctxOrDb)
        ctxOrDb.response = await this.query(request, routeOptions)
        return ctxOrDb.response
    }

    async query<T extends D1Entity>(
        req: LivequeryRequest,
        options: D1RouteOptions
    ): Promise<D1DatasourceResult<T>>
    async query<T extends D1Entity>(
        db: D1Database,
        req: LivequeryRequest,
        options: D1RouteOptions
    ): Promise<D1CollectionResult<T> | D1ItemResult<T>>
    async query<T extends D1Entity>(
        reqOrDb: LivequeryRequest | D1Database,
        reqOrOptions: LivequeryRequest | D1RouteOptions,
        legacyOptions?: D1RouteOptions
    ): Promise<D1DatasourceResult<T>> {
        if (this.#isD1Database(reqOrDb)) {
            // Backward-compatible direct read API: query(db, request, options).
            const request = this.#normalizeRequest(reqOrOptions as LivequeryRequest)
            return this.#read<T>(reqOrDb, request, legacyOptions as D1RouteOptions)
        }

        const request = this.#normalizeRequest(reqOrDb)
        const options = reqOrOptions as D1RouteOptions
        const db = await this.#resolveDatabase(request, options)
        return this.#dispatch<T>(db, request, options)
    }

    async add<T extends D1Entity>(
        db: D1Database,
        req: LivequeryRequest,
        options: D1RouteOptions
    ): Promise<D1ItemResult<T>> {
        const table = await this.#resolveTable(req, options)
        const body = (req.body as Record<string, unknown> | undefined) ?? {}
        // A client id is only taken once validated as a uuidv7; legacy `local:` ids are ignored.
        const client_id = options.clientIds === false ? undefined : resolveClientId(body)
        const { id: _clientId, ...rest } = body
        const keys = req.keys ?? {}
        // The body wins over a route key of the same name, deliberately. `rest` is the validated
        // body, so it can only carry columns the route's schema declares — a schema that declares
        // the route key's column is saying the client may set it. Deciding that here too would
        // make the datasource a second answer to "which columns may the client write".
        const data = { ...keys, ...rest, id: client_id ?? crypto.randomUUID() }
        // Route keys are set by the route definition, so they are writable even when absent from `fields`.
        const fields = options.fields && [...options.fields, ...Object.keys(keys)]
        const item = await D1Query.insert<T>(db, table, data, fields).catch(e => {
            const message = String((e as any)?.message ?? e)
            if (!message.includes('UNIQUE constraint failed')) throw e
            // A retried add finds its own first attempt here; the client treats the 409 as
            // "already created" and sends what changed since as an update.
            if (message.includes(`${table}.id`)) {
                throw { status: 409, code: ID_ALREADY_EXISTS, message: `A row with id ${data.id} already exists` }
            }
            throw { status: 409, code: 'DUPLICATE_KEY', message }
        })
        return { item: hidePrivateFields({ item }).item as T }
    }

    async update<T extends D1Entity>(
        db: D1Database,
        req: LivequeryRequest,
        options: D1RouteOptions
    ): Promise<D1ItemResult<T>> {
        const table = await this.#resolveTable(req, options)
        const id = req.document_id ?? req.keys?.id
        if (!id) {
            throw { status: 400, code: 'MISSING_ID', message: 'Document id is required for update' }
        }
        const body = (req.body as Record<string, unknown> | undefined) ?? {}
        const item = await D1Query.update<T>(db, table, id, body, req.keys ?? {}, options.fields)
        return { item: hidePrivateFields({ item }).item as T }
    }

    async delete<T extends D1Entity>(
        db: D1Database,
        req: LivequeryRequest,
        options: D1RouteOptions
    ): Promise<D1ItemResult<T>> {
        const table = await this.#resolveTable(req, options)
        const id = req.document_id ?? req.keys?.id
        if (!id) {
            throw { status: 400, code: 'MISSING_ID', message: 'Document id is required for delete' }
        }
        const item = await D1Query.delete<T>(db, table, id, req.keys ?? {})
        return { item: hidePrivateFields({ item }).item as T }
    }

    async #dispatch<T extends D1Entity>(
        db: D1Database,
        req: LivequeryRequest,
        options: D1RouteOptions,
        legacyErrors = false
    ): Promise<D1DatasourceResult<T>> {
        if (req.method === 'get') return this.#read<T>(db, req, options)
        if (req.method === 'post') return this.add<T>(db, req, options)
        if (req.method === 'put' || req.method === 'patch') return this.update<T>(db, req, options)
        if (req.method === 'delete') return this.delete<T>(db, req, options)

        if (legacyErrors) {
            throw {
                status: 405,
                code: 'METHOD_NOT_ALLOWED',
                message: `Method ${req.method} not allowed`,
            }
        }
        throw { status: 500, code: 'INVAILD_METHOD', message: 'Invaild method' }
    }

    async #read<T extends D1Entity>(
        db: D1Database,
        req: LivequeryRequest,
        options: D1RouteOptions
    ): Promise<D1CollectionResult<T> | D1ItemResult<T>> {
        const table = await this.#resolveTable(req, options)
        const isCollection = typeof req.is_collection === 'boolean'
            ? req.is_collection
            : !req.document_id

        if (isCollection) {
            const result = await D1Query.queryCollection<T>(db, table, req, options.fields)
            return {
                ...result,
                items: result.items.map(item => hidePrivateFields({ item }).item as T),
            }
        }

        const result = await D1Query.queryDocument<T>(db, table, req)
        if (!result.item) {
            throw { status: 404, code: 'NOT_FOUND', message: 'Document not found' }
        }
        return { item: hidePrivateFields({ item: result.item }).item as T }
    }

    #getOptions(ctx: LivequeryContext): D1RouteOptions {
        const routePath = ctx.request.ref || ctx.request.path
        const options = this.routes.get(this.#routeKey(ctx.request.method, routePath))
            || this.routes.get(routePath)
        if (!options) {
            throw {
                status: 404,
                code: 'ROUTE_OPTIONS_NOT_FOUND',
                message: `Route options for "${routePath}" not found`,
            }
        }
        return options
    }

    #routeKey(method: string | number, path: string): string {
        return `${String(method).toUpperCase()} ${path}`
    }

    #toLivequeryRequest(ctx: LivequeryContext): LivequeryRequest | undefined {
        const livequery = ctx.livequery
        if (!livequery) return undefined

        return this.#normalizeRequest({
            ref: livequery.ref,
            is_collection: !livequery.document_id,
            collection_ref: livequery.collection_ref,
            schema_collection_ref: livequery.schema_collection_ref,
            document_id: livequery.document_id,
            keys: livequery.keys ?? {},
            query: livequery.query ?? {},
            method: livequery.method,
            body: livequery.body,
        })
    }

    #normalizeRequest(req: LivequeryRequest): LivequeryRequest {
        return {
            ...req,
            keys: req.keys ?? {},
            query: req.query ?? {},
            is_collection: typeof req.is_collection === 'boolean'
                ? req.is_collection
                : !req.document_id,
            method: req.method?.toLowerCase(),
        }
    }

    async #resolveTable(req: LivequeryRequest, options: D1RouteOptions): Promise<string> {
        return typeof options.table === 'function' ? options.table(req) : options.table
    }

    async #resolveDatabase(req: LivequeryRequest, options: D1RouteOptions): Promise<D1Database> {
        if (!this.config) {
            throw { status: 500, code: 'DB_CONFIG_NOT_FOUND', message: 'Database config not found' }
        }

        const databaseName = typeof options.database === 'function'
            ? await options.database(req)
            : options.database || Object.keys(this.config.databases)[0] || 'default'
        const database = this.config.databases[databaseName]
        if (!database) {
            throw {
                status: 500,
                code: 'DB_CONNECTION_NOT_FOUND',
                message: `D1 database "${databaseName}" not found`,
            }
        }
        return database
    }

    #isD1Database(value: unknown): value is D1Database {
        return typeof value === 'object'
            && value !== null
            && typeof (value as D1Database).prepare === 'function'
            && typeof (value as D1Database).batch === 'function'
    }
}
