import type { Context } from 'hono'
import { LivequeryRequestParser, type LivequeryRequest } from '@livequery/core/workers'
import type { AppEnv } from './types.js'

export async function createLivequeryRequest(c: Context<AppEnv>): Promise<LivequeryRequest | undefined> {
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

async function readBody(c: Context<AppEnv>): Promise<unknown> {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') return undefined
    const ct = c.req.header('content-type') ?? ''
    if (!ct.includes('application/json')) return undefined
    try {
        return await c.req.raw.clone().json()
    } catch {
        return undefined
    }
}
