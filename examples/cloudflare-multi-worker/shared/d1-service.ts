import { D1Datasource } from '@livequery/d1'
import type { D1RouteOptions } from '@livequery/d1'
import { LivequeryRequestParser } from '@livequery/core/workers'
import type { LivequeryContext, LivequeryDatasourceInitConfig } from '@livequery/core/workers'

const QUERY_META_FIELDS = new Set([':limit', ':after', ':before', ':page'])
const QUERY_OPERATORS = new Set([
    'eq',
    'ne',
    'gt',
    'gte',
    'lt',
    'lte',
    'eq-number',
    'neq-number',
    'eq-boolean',
    'neq-boolean',
    'eq-null',
    'neq-null',
    'in',
    'nin',
    'like',
])

export type D1ServiceDefinition = {
    collectionPath: string
    documentPath: string
    table: string
    queryFields: readonly string[]
    writeFields: readonly string[]
    requiredCreateFields: readonly string[]
}

export type D1ServiceRequest = {
    request: Request
    routePath: string
    params: Record<string, string>
    query: Record<string, string>
    database: D1Database
    definition: D1ServiceDefinition
}

type ApiError = {
    status?: number
    code?: string
    message?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | undefined> {
    if (!['POST', 'PUT', 'PATCH'].includes(request.method.toUpperCase())) return undefined

    if (!request.headers.get('content-type')?.includes('application/json')) {
        throw {
            status: 415,
            code: 'UNSUPPORTED_MEDIA_TYPE',
            message: 'Content-Type must be application/json',
        }
    }

    let body: unknown
    try {
        body = await request.json()
    } catch {
        throw { status: 400, code: 'INVALID_JSON', message: 'Request body must be valid JSON' }
    }

    if (!isRecord(body)) {
        throw { status: 400, code: 'INVALID_BODY', message: 'Request body must be an object' }
    }
    return body
}

function queryField(key: string): string | undefined {
    if (QUERY_META_FIELDS.has(key)) return undefined
    if (key.startsWith(':') || key.startsWith('::')) return ''

    const parts = key.split(':')
    if (parts.length === 1) return parts[0]
    const operator = parts.pop()
    const field = parts.join(':')
    if (operator === 'sort') return field
    return operator && QUERY_OPERATORS.has(operator) ? field : ''
}

function validateRequest(ctx: LivequeryContext, definition: D1ServiceDefinition): void {
    const request = ctx.livequery
    if (!request) {
        throw { status: 400, code: 'INVALID_LIVEQUERY_REQUEST', message: 'Invalid Livequery request' }
    }

    const allowedQueryFields = new Set([...definition.queryFields, 'id'])
    for (const key of Object.keys(request.query ?? {})) {
        const field = queryField(key)
        if (field === undefined) continue
        if (!field || !allowedQueryFields.has(field)) {
            throw { status: 400, code: 'INVALID_QUERY_FIELD', message: `Query field "${key}" is not allowed` }
        }
    }

    if (request.body === undefined) return
    if (!isRecord(request.body)) {
        throw { status: 400, code: 'INVALID_BODY', message: 'Request body must be an object' }
    }

    const allowedWriteFields = new Set(definition.writeFields)
    for (const key of Object.keys(request.body)) {
        if (!allowedWriteFields.has(key)) {
            throw { status: 400, code: 'INVALID_BODY_FIELD', message: `Body field "${key}" is not allowed` }
        }
    }

    if (request.method === 'POST') {
        for (const key of definition.requiredCreateFields) {
            if (request.body[key] === undefined || request.body[key] === '') {
                throw { status: 400, code: 'MISSING_FIELD', message: `Body field "${key}" is required` }
            }
        }
    }
}

function datasourceRoutes(
    definition: D1ServiceDefinition
): Array<LivequeryDatasourceInitConfig<D1RouteOptions>> {
    // The datasource enforces the same allowlist again, so a gap in validateRequest cannot reach SQL.
    const options = {
        table: definition.table,
        fields: [...new Set([...definition.queryFields, ...definition.writeFields])],
    }
    return [
        { method: 'GET', path: definition.collectionPath, ...options },
        { method: 'POST', path: definition.collectionPath, ...options },
        { method: 'GET', path: definition.documentPath, ...options },
        { method: 'PUT', path: definition.documentPath, ...options },
        { method: 'PATCH', path: definition.documentPath, ...options },
        { method: 'DELETE', path: definition.documentPath, ...options },
    ]
}

function errorResponse(error: unknown): Response {
    const detail = isRecord(error) ? error as ApiError : {}
    const status = typeof detail.status === 'number' ? detail.status : 500
    const code = typeof detail.code === 'string' ? detail.code : 'INTERNAL_ERROR'
    const message = status < 500 && typeof detail.message === 'string'
        ? detail.message
        : 'Internal server error'

    if (status >= 500) {
        const cause = error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : error
        console.error(JSON.stringify({ event: 'd1_request_failed', code, cause }))
    }

    return Response.json({ error: { code, message } }, { status })
}

export async function handleD1ServiceRequest(input: D1ServiceRequest): Promise<Response> {
    try {
        const body = await readJsonBody(input.request)
        const ctx: LivequeryContext = {
            request: {
                path: new URL(input.request.url).pathname,
                ref: input.routePath,
                method: input.request.method,
                params: input.params,
                query: input.query,
                body,
                headers: new Map(input.request.headers.entries()),
            },
        }

        new LivequeryRequestParser().handle(ctx)
        validateRequest(ctx, input.definition)

        const datasource = new D1Datasource({ databases: { default: input.database } })
        await datasource.init(datasourceRoutes(input.definition))
        await datasource.handle(ctx)

        const status = input.request.method.toUpperCase() === 'POST' ? 201 : 200
        return Response.json(ctx.response ?? null, { status })
    } catch (error) {
        return errorResponse(error)
    }
}
