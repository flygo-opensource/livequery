import type { MiddlewareHandler } from 'hono'
import { createLivequeryRequest } from './request.js'

export function livequery(): MiddlewareHandler {
    return async (c, next) => {
        const req = await createLivequeryRequest(c)
        c.set('livequery' as never, req as never)
        await next()
    }
}
