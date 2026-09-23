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

/**
 * Path-scoped ownership — the first of the two authorization patterns.
 *
 *   app.get('/livequery/users/:owner/tasks', requireSelf('owner'), livequery(), d1(), ...)
 *
 * The route key becomes `WHERE owner = ?` in every query the datasource builds, and it is written
 * into the row on insert, so one check here covers list, read, create, update and delete. It also
 * covers realtime: the ref is `users/<owner>/tasks`, so a subscription can only ever carry rows
 * that passed this guard.
 *
 * The key must stay out of the write schema. It is authorized here, from the path — if it were
 * also a body field a client could send a different value, and nothing below would re-check it.
 */
export function requireSelf(key: string): MiddlewareHandler<AppEnv> {
    return async (c, next) => {
        if (c.req.param(key) !== c.get('principal')) {
            return c.json({ error: { code: 'FORBIDDEN', message: `Not your ${key}` } }, 403)
        }
        await next()
    }
}

/**
 * Lookup-based ownership — the second pattern, for a rule the path cannot express.
 *
 *   app.patch('/livequery/tasks/:id', requireOwnedTask(), livequery(), d1(), ...)
 *
 * A flat document route carries no owner, so the rule has to read the row before deciding. This is
 * the shape every data-dependent rule takes — "editable only while it is a draft", "readable if
 * the members list contains me" — a query here, a 403 before the datasource runs.
 *
 * It costs one extra read per request, and it only works for a *document*: a collection read
 * cannot be authorized this way, because there is no single row to check. Scope those with
 * `requireSelf` instead.
 */
export function requireOwnedTask(): MiddlewareHandler<AppEnv> {
    return async (c, next) => {
        const row = await c.env.DB
            .prepare('SELECT owner FROM tasks WHERE id = ?')
            .bind(c.req.param('id'))
            .first<{ owner: string }>()

        // A missing row is reported as 404 rather than 403, so the guard does not tell an
        // unauthorized caller which task ids exist.
        if (!row) return c.json({ error: { code: 'NOT_FOUND', message: 'Task not found' } }, 404)
        if (row.owner !== c.get('principal')) {
            return c.json({ error: { code: 'FORBIDDEN', message: 'Not your task' } }, 403)
        }
        await next()
    }
}
