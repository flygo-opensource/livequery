import {
    LivequeryRequestParser,
    type LivequeryContext,
    type RawRequest,
    type WebsocketGatewayBase,
} from '@livequery/core'
import type { TaskStore } from './TaskStore.ts'

const COLLECTION_PATH = '/livequery/tasks'
const DOCUMENT_PATH = '/livequery/tasks/:id'

/** Routes this service owns. The service publishes them; the gateway routes by them. */
export const TASK_ROUTES = [
    { method: 'GET', path: COLLECTION_PATH },
    { method: 'POST', path: COLLECTION_PATH },
    { method: 'GET', path: DOCUMENT_PATH },
    { method: 'PUT', path: DOCUMENT_PATH },
    { method: 'PATCH', path: DOCUMENT_PATH },
    { method: 'DELETE', path: DOCUMENT_PATH },
]

type Route = { ref: string; params: Record<string, string> }

function matchRoute(pathname: string): Route | undefined {
    if (pathname === COLLECTION_PATH) return { ref: COLLECTION_PATH, params: {} }
    const match = /^\/livequery\/tasks\/([^/]+)$/.exec(pathname)
    if (match) return { ref: DOCUMENT_PATH, params: { id: decodeURIComponent(match[1]) } }
    return undefined
}

async function readJson(request: Request): Promise<unknown> {
    if (request.method === 'GET' || request.method === 'DELETE') return undefined
    try {
        return await request.json()
    } catch {
        throw { status: 400, code: 'INVALID_JSON', message: 'Request body must be valid JSON' }
    }
}

function errorResponse(error: unknown): Response {
    const e = (typeof error === 'object' && error !== null ? error : {}) as {
        status?: number
        code?: string
        message?: string
    }
    const status = typeof e.status === 'number' ? e.status : 500
    if (status >= 500) console.error(error)
    const body = status >= 500
        ? { code: 'INTERNAL', message: 'Internal error' }
        : { code: e.code ?? 'BAD_REQUEST', message: e.message ?? 'Bad request' }
    return Response.json({ error: body }, { status })
}

/**
 * The whole service API as a Fetch handler, so the Node and Bun services share it.
 *
 * After a successful read it calls `realtime.handle(ctx)`: the gateway forwarded the client's
 * `x-lcid` (client id) and `x-lgid` (gateway id), and the service subscribes that client to the
 * ref through the gateway's WebSocket link.
 */
export async function handleTaskRequest(
    request: Request,
    store: TaskStore,
    realtime: WebsocketGatewayBase
): Promise<Response> {
    const url = new URL(request.url)
    const route = matchRoute(url.pathname)
    if (!route) return Response.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, { status: 404 })

    try {
        const raw: RawRequest = {
            path: url.pathname,
            ref: route.ref,
            method: request.method,
            params: route.params,
            query: Object.fromEntries(url.searchParams),
            body: await readJson(request),
            headers: new Map(request.headers),
        }
        const ctx: LivequeryContext = { request: raw, livequery: LivequeryRequestParser.parse(raw) }
        const req = ctx.livequery
        if (!req) throw { status: 400, code: 'INVALID_LIVEQUERY_REQUEST', message: 'Invalid Livequery request' }
        const is_document = route.params.id !== undefined

        switch (request.method) {
            case 'GET': {
                const result = is_document ? store.get(req) : store.list(req)
                realtime.handle(ctx)
                return Response.json(result)
            }
            case 'POST':
                if (is_document) break
                return Response.json(store.add(req), { status: 201 })
            case 'PUT':
            case 'PATCH':
                if (!is_document) break
                return Response.json(store.update(req))
            case 'DELETE':
                if (!is_document) break
                return Response.json(store.delete(req))
        }
        return Response.json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } }, { status: 405 })
    } catch (error) {
        return errorResponse(error)
    }
}
