import type { Context } from 'hono'
import { LivequeryRequestParser } from '@livequery/core'
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
            ref: options.routePath ?? c.req.path,
            method: c.req.method.toUpperCase(),
            params: c.req.param(),
            query: c.req.query(),
            body: options.body ?? await readBody(c),
            headers: new Map(Object.entries(c.req.header())),
        },
    }
    return parser.handle(ctx)
}

export function getLivequeryRequest(c: Context): LivequeryRequest<unknown> {
    return c.get('livequery' as never) as LivequeryRequest<unknown>
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
