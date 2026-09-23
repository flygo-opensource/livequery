import { LIVEQUERY_VARS, toLivequeryError, type LivequeryRequest } from '@livequery/core'
import { D1Datasource } from './D1Datasource.js'
import { assertTable } from './helpers/assertTable.js'
import type { D1RouteOptions } from './types.js'

/** Minimal Hono context, declared structurally so this package needs no Hono dependency. */
type D1Context = {
    env: Record<string, unknown>
    res: Response
    req: { method: string }
    get(key: string): unknown
    set(key: string, value: unknown): void
    json(body: unknown, status?: number): Response
}

type Next = () => Promise<void>

export type D1MiddlewareOptions = {
    /** D1 binding name on `env`. Default `DB`. */
    binding?: string
    /** Table name. Default: the request's collection ref, e.g. `tasks` for /livequery/tasks/:id. */
    table?: string | ((req: LivequeryRequest) => string)
    /**
     * Columns a client may filter, sort or write. Defaults to the fields of the route's
     * `validator()` schema; without either, only well-formed column names are enforced.
     */
    fields?: readonly string[]
    /** Accept the uuidv7 a client sends as the new row's id (default true). See `D1RouteOptions.clientIds`. */
    clientIds?: boolean
}

type SchemaLike = { shape?: Record<string, unknown>; entries?: Record<string, unknown> }

const datasource = new D1Datasource()
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
 * Run the request against D1 and hand the result to the middlewares after it.
 *
 *   app.post('/livequery/tasks', validator(Task), livequery(), d1(), realtime())
 *
 * The operation follows the method and the ref: a collection GET lists, a document GET reads,
 * POST inserts, PUT/PATCH update, DELETE removes. The result is published as
 * `livequery_result` and `next()` runs before the JSON response is built, so `realtime()` and
 * any other post-processing can see it. A failing query throws instead, so nothing downstream
 * publishes a change that did not happen.
 */
export function d1(options: D1MiddlewareOptions = {}) {
    return async (c: D1Context, next: Next): Promise<Response> => {
        const req = c.get(LIVEQUERY_VARS.request) as LivequeryRequest | undefined
        if (!req) {
            throw new Error('d1() requires livequery() earlier in the chain')
        }

        const binding = options.binding ?? 'DB'
        const database = c.env[binding] as D1Database | undefined
        if (!database) {
            throw new Error(`d1(): no D1 binding named "${binding}" on env`)
        }

        const table = assertTable(typeof options.table === 'function'
            ? options.table(req)
            : options.table ?? (req.collection_ref ?? req.ref).split('/').pop() ?? '')

        const fields = options.fields ?? fieldsOf(c.get(LIVEQUERY_VARS.schema))
        if (!fields) {
            warnOnce(table, `livequery: d1() on "${table}" has no column allowlist; `
                + 'add validator(Schema) or d1({ fields }) so clients cannot reach other columns')
        }

        const route: D1RouteOptions = {
            table,
            ...fields ? { fields } : {},
            ...options.clientIds === false ? { clientIds: false } : {},
        }
        const method = req.method?.toUpperCase() ?? c.req.method.toUpperCase()
        let result: unknown
        try {
            result = method === 'POST'
                ? await datasource.add(database, req, route)
                : method === 'PUT' || method === 'PATCH'
                    ? await datasource.update(database, req, route)
                    : method === 'DELETE'
                        ? await datasource.delete(database, req, route)
                        : await datasource.query(database, req, route)
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
        c.res = c.json(result, method === 'POST' ? 201 : 200)
        await next()
        return c.res
    }
}
