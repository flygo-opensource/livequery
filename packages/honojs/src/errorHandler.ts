import type { Context, Env, ErrorHandler } from 'hono'
import { toLivequeryError } from '@livequery/core'

/**
 * Turn a thrown Livequery error into the protocol's error response.
 *
 *   app.onError(errorHandler())
 *
 * A 4xx keeps its `code` and `message`, since the client needs both to react. A 5xx is logged and
 * answered with a generic body: database errors carry SQL and internals that must not leave the
 * server.
 */
export function errorHandler<E extends Env = any>(): ErrorHandler<E> {
    return (thrown: Error, c: Context<E>) => {
        const error = toLivequeryError(thrown)
        if (error.status >= 500) {
            console.error(JSON.stringify({ event: 'request_failed', message: error.message }))
            return c.json({ error: { code: 'INTERNAL', message: 'Internal error' } }, 500)
        }
        return c.json({ error: { code: error.code, message: error.message } }, error.status as never)
    }
}
