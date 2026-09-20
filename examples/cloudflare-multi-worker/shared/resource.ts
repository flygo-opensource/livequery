import { Hono } from 'hono'
import { errorHandler, livequery, realtime, validator, type LivequerySchema } from '@livequery/honojs'
import { d1 } from '@livequery/d1'

export type ResourceOptions = {
    /** Collection name; also the D1 table and the path segment under /livequery. */
    name: string
    /** D1 binding on `env`. */
    binding: string
    /** Validates writes, and doubles as the column allowlist for filters, sorts and writes. */
    schema: LivequerySchema
    /** Schema for PATCH, where only the changed fields are sent (`z.partial(schema)`). */
    patch?: LivequerySchema
}

/**
 * The five Livequery routes of one resource, as a Hono app the service mounts.
 *
 * `realtime()` takes no argument here: these services sit behind the gateway, so they only
 * annotate the response and the gateway does the registering and publishing.
 */
export function resource<E extends { Bindings: Record<string, unknown> }>(options: ResourceOptions): Hono<E> {
    const { name, binding, schema, patch } = options
    const app = new Hono<E>()
    const source = d1({ binding, table: name })
    const check = validator(schema, patch ? { patch } : {})

    app.onError(errorHandler())
    app.get(`/livequery/${name}`, check, livequery(), source, realtime())
    app.post(`/livequery/${name}`, check, livequery(), source, realtime())
    app.get(`/livequery/${name}/:id`, check, livequery(), source, realtime())
    app.put(`/livequery/${name}/:id`, check, livequery(), source, realtime())
    app.patch(`/livequery/${name}/:id`, check, livequery(), source, realtime())
    app.delete(`/livequery/${name}/:id`, livequery(), source, realtime())
    return app
}
