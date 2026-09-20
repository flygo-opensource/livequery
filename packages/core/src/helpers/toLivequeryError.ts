/** The shape every Livequery layer throws: a flat `{ code, message, status? }`. */
export type LivequeryError = Error & {
    status: number
    code: string
}

/**
 * Normalize anything thrown into an `Error` that carries `status` and `code`.
 *
 * Datasources throw plain objects (`throw { status: 400, code: 'INVALID_FIELD', ... }`), but
 * frameworks only route real `Error` instances to their error handler — Hono rethrows anything
 * else, which surfaces as an opaque 500. Middlewares convert at their boundary with this.
 */
export function toLivequeryError(thrown: unknown): LivequeryError {
    if (thrown instanceof Error && 'status' in thrown && 'code' in thrown) {
        return thrown as LivequeryError
    }

    const source = (typeof thrown === 'object' && thrown !== null ? thrown : {}) as {
        status?: unknown
        code?: unknown
        message?: unknown
    }
    const status = typeof source.status === 'number' ? source.status : 500
    const message = typeof source.message === 'string'
        ? source.message
        : thrown instanceof Error ? thrown.message : 'Internal error'

    const error = new Error(message, thrown instanceof Error ? { cause: thrown } : { cause: thrown })
    return Object.assign(error, {
        status,
        code: typeof source.code === 'string' ? source.code : status >= 500 ? 'INTERNAL' : 'BAD_REQUEST',
    })
}
