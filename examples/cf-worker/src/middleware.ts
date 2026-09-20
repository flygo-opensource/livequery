import type { MiddlewareHandler } from 'hono'
import { createLivequeryRequest } from './request.js'
import type { AppEnv } from './types.js'

export function livequery(): MiddlewareHandler<AppEnv> {
    return async (c, next) => {
        const req = await createLivequeryRequest(c)
        if (!req) {
            return c.json({ error: { code: 'INVALID_LIVEQUERY_REQUEST', message: 'Invalid Livequery request' } }, 400)
        }
        c.set('livequery', req)
        await next()
    }
}
