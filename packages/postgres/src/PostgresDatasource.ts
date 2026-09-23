import { Cursor } from './Cursor.js'
import type {
    LivequeryContext,
    LivequeryDatasource as CoreLivequeryDatasource,
    LivequeryDatasourceInitConfig
} from '@livequery/core'
import type { LivequeryRequest, LivequeryBaseEntity, Paging, UpdatedData } from '@livequery/core'
import { ID_ALREADY_EXISTS, resolveClientId } from '@livequery/core'
import { PostgresQuery, type PostgresTable } from './PostgresQuery.js'
import { SmartCache } from './SmartCache.js'
import { Sql, ident, qualifiedTable, exec, type PostgresConnection } from './Sql.js'
import { Subject } from 'rxjs'


export type PostgresDatasourceConfig = {
    connections: { [key: string]: PostgresConnection },
    schemas?: string[]
}

export type RouteOptions = {
    realtime?: boolean
    table: string | ((req: LivequeryRequest) => Promise<string> | string),
    schema?: string | ((req: LivequeryRequest) => Promise<string> | string),
    connection?: string | ((req: LivequeryRequest) => Promise<string> | string),
    // Physical primary-key column exposed to clients as `id`. Defaults to 'id'.
    idField?: string,
    // Columns scanned (case-insensitively) by the `:search` query option.
    searchFields?: string[],
    // Accept the uuidv7 a client sends as the new row's id, so a retried add cannot create a
    // second row (the primary key rejects it: 409 ID_ALREADY_EXISTS). Default true. Set false for
    // tables whose key is not a uuid/text column (serial, bigint); the id is then ignored.
    clientIds?: boolean,
}


export class PostgresDatasource extends Subject<UpdatedData<LivequeryBaseEntity>> implements CoreLivequeryDatasource<RouteOptions> {

    #tables = new SmartCache()
    public readonly refs = new Map<string, Set<string>>()

    config: PostgresDatasourceConfig
    routes: Map<string, RouteOptions>
    constructor(config?: PostgresDatasourceConfig) {
        super()
        if (config) this.config = config
        this.routes = new Map()
    }

    async init(routes: Array<LivequeryDatasourceInitConfig<RouteOptions>>): Promise<void> {
        this.routes = routes.reduce((p, c) => {
            const { method, path, ...options } = c
            const routeOptions = options as RouteOptions
            if (!routeOptions.table) return p

            const key = this.#routeKey(c.method, c.path)
            const set = p.get(key) || p.get(c.path)
            if (set && set.table != routeOptions.table) throw new Error('Table mismatch for route path "' + c.path + '"')
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
        const table = await this.#getTable(req, options)
        const query = this.#normalizeRequest(req)

        if (query.method == 'get') return await this.#get(query, table)
        if (query.method == 'post') return this.#post(query, table, options)
        if (query.method == 'put') return this.#put(query, table)
        if (query.method == 'patch') return this.#patch(query, table)
        if (query.method == 'delete') return this.#del(query, table)
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

    async #getTable(req: LivequeryRequest, options: RouteOptions): Promise<PostgresTable> {
        const connectionName = typeof options.connection == 'function' ? await options.connection(req) : (options.connection || Object.keys(this.config.connections)[0] || 'default')
        const schemaName = typeof options.schema == 'function' ? await options.schema(req) : (options.schema || process.env.PG_SCHEMA || 'public')
        const tableName = typeof options.table == 'function' ? await options.table(req) : options.table
        const idField = options.idField || 'id'

        // Only the resolved physical location (connection + qualified name + id column) is
        // cached — those are keyed below. `searchFields` is a per-route concern, so it is
        // layered on from `options` each call rather than baked into the shared descriptor.
        const core = await this.#tables.get(`${connectionName}|${schemaName}|${tableName}|${idField}`, async () => {
            const connection = this.config.connections[connectionName]
            if (!connection) throw { status: 500, code: 'DB_CONNECTION_NOT_FOUND', message: `Database connection "${connectionName}" not found` }
            return {
                db: connection,
                name: qualifiedTable(schemaName, tableName),
                idField,
            }
        })

        return { ...core, searchFields: options.searchFields }
    }

    async #get<T extends LivequeryBaseEntity>(req: LivequeryRequest<T>, table: PostgresTable) {

        const {
            limit,
            items,
            count,
            has,
            summary
        } = await PostgresQuery.query(req, table)


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

    async #post(req: LivequeryRequest, table: PostgresTable, options: RouteOptions) {
        const client_id = options.clientIds === false ? undefined : resolveClientId(req.body)
        const { id: _bodyId, ...body } = (req.body ?? {}) as Record<string, any>
        const merged = this.#mapId({ ...req.keys, ...body, ...client_id ? { id: client_id } : {} }, table.idField)
        const cols = Object.keys(merged)
        const sql = new Sql()

        const text = cols.length === 0
            ? `INSERT INTO ${table.name} DEFAULT VALUES RETURNING *`
            : `INSERT INTO ${table.name} (${cols.map(ident).join(', ')}) VALUES (${cols.map(c => sql.param(merged[c])).join(', ')}) RETURNING *`

        const rows = await exec(table.db, text, sql.values).catch(e => {
            // unique_violation: a retried add finds its own first attempt on the primary key.
            if (e?.code === '23505') {
                const on_key = String(e?.constraint ?? '').endsWith('_pkey')
                throw on_key
                    ? { status: 409, code: ID_ALREADY_EXISTS, message: `A row with id ${client_id} already exists` }
                    : { status: 409, code: 'DUPLICATE_KEY', message: String(e?.detail ?? e?.message ?? e) }
            }
            // invalid_text_representation on the key: the column is not a uuid/text column.
            if (e?.code === '22P02' && client_id) {
                throw { status: 400, code: 'INVALID_ID', message: `The key of ${table.name} does not take a uuid; set clientIds: false on this route` }
            }
            throw e
        })
        return { item: this.#mapRow(rows[0], table.idField) ?? this.#writtenItem(req) }
    }

    async #put(req: LivequeryRequest, table: PostgresTable) {
        return this.#write(req, table)
    }

    async #patch(req: LivequeryRequest, table: PostgresTable) {
        return this.#write(req, table)
    }

    async #write(req: LivequeryRequest, table: PostgresTable) {
        const sql = new Sql()
        const sets = this.#buildSet(sql, req.body, table.idField)
        const where = this.#whereKeys(sql, req.keys, table.idField)

        // Nothing to update -> echo the request shape instead of issuing empty SQL.
        if (sets.length === 0) return { item: this.#writtenItem(req) }

        const text = `UPDATE ${table.name} SET ${sets.join(', ')}${where ? ` WHERE ${where}` : ''} RETURNING *`
        const rows = await exec(table.db, text, sql.values)
        return { item: this.#mapRow(rows[0], table.idField) ?? this.#writtenItem(req) }
    }

    async #del(req: LivequeryRequest, table: PostgresTable) {
        const sql = new Sql()
        const where = this.#whereKeys(sql, req.keys, table.idField)
        const text = `DELETE FROM ${table.name}${where ? ` WHERE ${where}` : ''} RETURNING *`
        const rows = await exec(table.db, text, sql.values)
        return { item: this.#mapRow(rows[0], table.idField) ?? this.#writtenItem(req) }
    }

    // Translate an update body into `SET` assignments. Plain bodies set each column to a
    // bound value. Operator bodies map a small mongo-flavoured set onto SQL arithmetic:
    // $set / $inc / $dec / $mul / $unset.
    #buildSet(sql: Sql, body: any, idField: string): string[] {
        if (!body || typeof body !== 'object') return []
        const hasOperators = Object.keys(body).some(k => k.startsWith('$'))

        if (!hasOperators) {
            return Object.entries(this.#mapId(body, idField)).map(([k, v]) => `${ident(k)} = ${sql.param(v)}`)
        }

        const sets: string[] = []
        for (const [op, payload] of Object.entries(body as Record<string, any>)) {
            if (op === '$set') {
                for (const [k, v] of Object.entries(this.#mapId(payload, idField))) sets.push(`${ident(k)} = ${sql.param(v)}`)
            } else if (op === '$inc') {
                for (const [k, v] of Object.entries(payload)) sets.push(`${ident(k)} = ${ident(k)} + ${sql.param(v)}`)
            } else if (op === '$dec') {
                for (const [k, v] of Object.entries(payload)) sets.push(`${ident(k)} = ${ident(k)} - ${sql.param(v)}`)
            } else if (op === '$mul') {
                for (const [k, v] of Object.entries(payload)) sets.push(`${ident(k)} = ${ident(k)} * ${sql.param(v)}`)
            } else if (op === '$unset') {
                const keys = Array.isArray(payload) ? payload : Object.keys(payload)
                for (const k of keys) sets.push(`${ident(k)} = NULL`)
            }
        }
        return sets
    }

    #whereKeys(sql: Sql, keys: Record<string, any>, idField: string): string {
        return Object.entries(keys || {})
            .map(([k, v]) => `${ident(k == 'id' ? idField : k)} = ${sql.param(v)}`)
            .join(' AND ')
    }

    // Rename the public `id` field onto the physical primary-key column on write.
    #mapId(obj: Record<string, any>, idField: string): Record<string, any> {
        if (idField === 'id' || !obj || !('id' in obj)) return { ...obj }
        const { id, ...rest } = obj
        return { ...rest, [idField]: id }
    }

    // Rename the physical primary-key column back to `id` on a returned row.
    #mapRow(row: any, idField: string): any | undefined {
        if (!row) return undefined
        if (idField === 'id') return row
        const { [idField]: pk, ...rest } = row
        return { id: pk, ...rest }
    }

    // Build the standard Livequery `{ id, ...data }` shape for a write response from the
    // request keys + body when the database returned nothing via RETURNING. Operator
    // bodies ($set/$inc/...) are not spread into the returned item.
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

}
