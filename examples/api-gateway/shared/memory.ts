import { LIVEQUERY_VARS, toLivequeryError, type LivequeryRequest } from '@livequery/core'
import type { TaskStore } from './TaskStore.ts'

type MemoryContext = {
    res: Response
    req: { method: string }
    get(key: string): unknown
    set(key: string, value: unknown): void
    json(body: unknown, status?: number): Response
}

/**
 * An in-memory datasource middleware, shaped exactly like `d1()` from `@livequery/d1`: it runs
 * the operation, publishes the result, builds the response and then runs the rest of the chain,
 * so `realtime()` can sit after it.
 *
 * Swap it for `d1()`, `postgres()` or `mongodb()` without touching the routes.
 */
export function memory(store: TaskStore) {
    return async (c: MemoryContext, next: () => Promise<void>): Promise<Response> => {
        const req = c.get(LIVEQUERY_VARS.request) as LivequeryRequest | undefined
        if (!req) throw new Error('memory() requires livequery() earlier in the chain')

        const method = (req.method ?? c.req.method).toUpperCase()
        let result: unknown
        try {
            result = method === 'POST' ? store.add(req)
                : method === 'PUT' || method === 'PATCH' ? store.update(req)
                    : method === 'DELETE' ? store.delete(req)
                        : req.document_id ? store.get(req) : store.list(req)
        } catch (e) {
            throw toLivequeryError(e)
        }

        c.set(LIVEQUERY_VARS.result, result)
        c.res = c.json(result, method === 'POST' ? 201 : 200)
        await next()
        return c.res
    }
}
