import type { MiddlewareHandler } from 'hono'
import { authenticate } from './authenticate.js'
import type { AppEnv } from './types.js'

export function requireAuth(): MiddlewareHandler<AppEnv> {
    return async (c, next) => {
        const principal = await authenticate(c.req.raw, c.env)
        if (!principal) {
            return c.json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } }, 401)
        }
        c.set('principal', principal)
        await next()
    }
}
