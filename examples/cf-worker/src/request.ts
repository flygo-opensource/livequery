import type { Context } from 'hono'
import { LivequeryRequestParser } from '@livequery/core'
import type { LivequeryRequest } from '@livequery/core'

export async function createLivequeryRequest(c: Context): Promise<LivequeryRequest | undefined> {
    const body = await readBody(c)
    try {
        return LivequeryRequestParser.parse({
            path: c.req.path,
            ref: c.req.routePath,
            method: c.req.method.toUpperCase(),
            params: c.req.param(),
            query: c.req.query(),
            body,
            headers: new Map(Object.entries(c.req.header())),
        })
    } catch {
        return undefined
    }
}

export function getLivequeryRequest(c: Context): LivequeryRequest | undefined {
    return c.get('livequery' as never) as LivequeryRequest | undefined
}

export async function readBody(c: Context): Promise<unknown> {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') return undefined
    const ct = c.req.header('content-type') ?? ''
    if (!ct.includes('application/json')) return undefined
    try {
        return await c.req.raw.clone().json()
    } catch {
        return undefined
    }
}
