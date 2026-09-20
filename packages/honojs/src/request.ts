import type { Context } from 'hono'
import { LIVEQUERY_VARS, LivequeryRequestParser } from '@livequery/core'
import type { LivequeryContext as CoreCtx, LivequeryRequest } from '@livequery/core'

const parser = new LivequeryRequestParser()

export type CreateLivequeryRequestOptions = {
    routePath?: string
    body?: unknown
}

export async function createLivequeryRequest(
    c: Context,
    options: CreateLivequeryRequestOptions = {}
): Promise<LivequeryRequest<unknown> | undefined> {
    const ctx: CoreCtx = {
        request: {
            path: c.req.path,
            // Hono's route pattern (e.g. /livequery/tasks/:id) is what tells the parser which
            // segment is the document id; the literal path alone cannot.
            ref: options.routePath ?? c.req.routePath ?? c.req.path,
            method: c.req.method.toUpperCase(),
            params: c.req.param(),
            query: c.req.query(),
            // Prefer the validated body so schema defaults and transforms survive.
            body: options.body ?? c.get(LIVEQUERY_VARS.body as never) ?? await readBody(c),
            headers: new Map(Object.entries(c.req.header())),
        },
    }
    return parser.handle(ctx)
}

export function getLivequeryRequest(c: Context): LivequeryRequest<unknown> {
    return c.get(LIVEQUERY_VARS.request as never) as LivequeryRequest<unknown>
}

async function readBody(c: Context): Promise<unknown> {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') return undefined
    const contentType = c.req.header('content-type') ?? ''
    if (!contentType.includes('application/json')) return undefined
    try {
        return await c.req.raw.clone().json()
    } catch {
        return undefined
    }
}
