import { LIVEQUERY_VARS, toLivequeryError, type LivequeryRequest } from '@livequery/core'
import { MongoDatasource, type MongoConnection, type RouteOptions } from './MongoDatasource.js'

/** Minimal Hono context, declared structurally so this package needs no Hono dependency. */
type MongoContext = {
    res: Response
    req: { method: string }
    get(key: string): unknown
    set(key: string, value: unknown): void
    json(body: unknown, status?: number): Response
}

type Next = () => Promise<void>

export type MongodbMiddlewareOptions = {
    /** A `Db`, or a `MongoClient` plus `db`. */
    connection: MongoConnection
    /** Database name, when `connection` is a client. Defaults to `DB_NAME` or `main`. */
    db?: RouteOptions['db']
    /** Collection name. Default: the request's collection ref, e.g. `todos` for /livequery/todos/:id. */
    collection?: RouteOptions['collection']
    /** Fields stored as ObjectId, so a hex string in a filter is converted before the query. */
    objectIdFields?: string[]
    /**
     * Fields a client may filter, sort or search on. Defaults to the fields of the route's
     * `validator()` schema; without either, any field name in the query reaches MongoDB.
     */
    fields?: readonly string[]
}

type SchemaLike = { shape?: Record<string, unknown>; entries?: Record<string, unknown> }

const warned = new Set<string>()

function fieldsOf(schema: unknown): string[] | undefined {
    const shape = (schema as SchemaLike | undefined)?.shape ?? (schema as SchemaLike | undefined)?.entries
    return shape ? Object.keys(shape) : undefined
}

function warnOnce(key: string, message: string): void {
    if (warned.has(key)) return
    warned.add(key)
    console.warn(message)
}

/**
 * Reject a query that touches a field outside the allowlist. Keys starting with `:` are the
 * protocol's own (`:limit`, `:after`, `:search`, `::summary`); every other key is
 * `field` or `field:operator`, including `field:sort`.
 */
function assertFields(query: Record<string, unknown>, fields: readonly string[]): void {
    const allowed = new Set([...fields, 'id'])
    for (const key of Object.keys(query)) {
        if (key.startsWith(':')) continue
        const field = key.split(':')[0]
        if (!field || allowed.has(field)) continue
        // A plain `{ status, code, message }` never reaches a framework error handler.
        throw toLivequeryError({
            status: 400,
            code: 'FIELD_NOT_ALLOWED',
            message: `Field "${field}" is not queryable on this route`,
        })
    }
}

/**
 * Run the request against MongoDB and hand the result to the middlewares after it.
 *
 *   app.post('/livequery/todos', validator(Todo), livequery(), mongodb({ connection: db }))
 *
 * The operation follows the method and the ref: a collection GET lists, a document GET reads,
 * POST inserts, PUT/PATCH update, DELETE removes. The result is published as `livequery_result`
 * and `next()` runs before the response is returned, so `realtime()` and any other
 * post-processing can see it. A failing query throws instead, so nothing downstream publishes
 * a change that did not happen.
 *
 * Realtime is optional here: a service with `MongodbRealtime.watch()` gets its changes from the
 * change stream, which also covers writes that never went through this middleware.
 */
export function mongodb(options: MongodbMiddlewareOptions) {
    const datasource = new MongoDatasource({ connections: { default: options.connection } })

    return async (c: MongoContext, next: Next): Promise<Response> => {
        const req = c.get(LIVEQUERY_VARS.request) as LivequeryRequest | undefined
        if (!req) throw new Error('mongodb() requires livequery() earlier in the chain')

        const collection = options.collection ?? (req.collection_ref ?? req.ref).split('/').pop() ?? ''
        if (!collection) throw new Error('mongodb(): cannot infer a collection from the request ref')

        const fields = options.fields ?? fieldsOf(c.get(LIVEQUERY_VARS.schema))
        if (fields) assertFields(req.query ?? {}, fields)
        else warnOnce(String(collection), `livequery: mongodb() on "${String(collection)}" has no field allowlist; `
            + 'add validator(Schema) or mongodb({ fields }) so clients cannot query other fields')

        const route: RouteOptions = {
            collection,
            ...options.db ? { db: options.db } : {},
            ...options.objectIdFields ? { objectIdFields: options.objectIdFields } : {},
        }

        let result: unknown
        try {
            result = await datasource.query(req, route)
        } catch (e) {
            // The datasource throws plain `{ status, code, message }` objects, which a framework
            // error handler never sees; hand it a real Error carrying the same fields.
            throw toLivequeryError(e)
        }

        c.set(LIVEQUERY_VARS.result, result)
        // Build the response before running the rest of the chain. Hono drops what a handler
        // returns once a response exists, and it answers 404 when a chain ends with a next() that
        // nothing handles — setting it up front avoids both, and `c.header(...)` from a middleware
        // after this one still lands on the response.
        c.res = c.json(result, (req.method ?? c.req.method).toUpperCase() === 'POST' ? 201 : 200)
        await next()
        return c.res
    }
}
