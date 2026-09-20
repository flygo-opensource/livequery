import type { Env, MiddlewareHandler } from 'hono'
import { LIVEQUERY_VARS } from '@livequery/core'

/**
 * The subset of the Standard Schema contract this adapter needs, declared structurally so the
 * package takes no dependency on zod, valibot or arktype.
 */
export type LivequerySchema = {
    '~standard': {
        validate(value: unknown): StandardResult | Promise<StandardResult>
    }
    /** zod exposes the object's fields here; used as the column allowlist. */
    shape?: Record<string, unknown>
    /** valibot exposes them here. */
    entries?: Record<string, unknown>
    /** Used for PATCH, where only the sent fields are validated. */
    partial?: () => LivequerySchema
}

type StandardIssue = {
    message: string
    path?: ReadonlyArray<PropertyKey | { key: PropertyKey }>
}

type StandardResult = {
    value?: unknown
    issues?: ReadonlyArray<StandardIssue>
}

const PARTIAL_METHODS = new Set(['PATCH'])
const VALIDATED_METHODS = new Set(['POST', 'PUT', 'PATCH'])

/** Columns a schema declares, or undefined when its shape cannot be read. */
export function fieldsOf(schema: LivequerySchema): string[] | undefined {
    const shape = schema.shape ?? schema.entries
    return shape ? Object.keys(shape) : undefined
}

function issuePath(issue: StandardIssue): string {
    return (issue.path ?? [])
        .map(segment => String(typeof segment === 'object' ? segment.key : segment))
        .join('.')
}

/**
 * Validate the request body against a Standard Schema, and publish the schema as the route's
 * column allowlist for the datasource middleware.
 *
 *   app.post('/livequery/tasks', validator(Task), livequery(), d1())
 *
 * Runs before `livequery()`, which then parses the validated body so defaults and transforms
 * survive. `PATCH` validates against `schema.partial()` when the schema offers it, since a patch
 * sends only the fields it changes. `GET` and `DELETE` carry no body: the schema is published for
 * the allowlist but nothing is validated.
 */
export type ValidatorOptions = {
    /**
     * Schema for PATCH, where only the changed fields are sent. Defaults to `schema.partial()`
     * for libraries that expose it (zod). Libraries with a functional API have no such method —
     * pass `z.partial(Schema)` (zod/mini) or `v.partial(Schema)` (valibot) here.
     */
    patch?: LivequerySchema
}

export function validator<E extends Env = any>(
    schema: LivequerySchema,
    options: ValidatorOptions = {}
): MiddlewareHandler<E, any> {
    const partial = options.patch ?? (typeof schema.partial === 'function' ? schema.partial() : undefined)
    let warned = false

    return async (c, next) => {
        c.set(LIVEQUERY_VARS.schema as never, schema as never)

        if (!VALIDATED_METHODS.has(c.req.method.toUpperCase())) return next()

        let body: unknown
        try {
            body = await c.req.raw.clone().json()
        } catch {
            return c.json({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON' } }, 400)
        }

        const is_patch = PARTIAL_METHODS.has(c.req.method.toUpperCase())
        if (is_patch && !partial) {
            // Validating a patch against the full schema would reject every partial update, so
            // skip it. Columns stay restricted to the schema's fields through the allowlist.
            if (!warned) {
                warned = true
                console.warn('livequery: validator() cannot build a partial schema for PATCH; '
                    + 'pass { patch: z.partial(Schema) } to validate patches too')
            }
            c.set(LIVEQUERY_VARS.body as never, body as never)
            return next()
        }

        const target = is_patch && partial ? partial : schema
        const result = await target['~standard'].validate(body)
        if (result.issues?.length) {
            return c.json({
                error: {
                    code: 'VALIDATION_FAILED',
                    message: result.issues.map(issue => {
                        const path = issuePath(issue)
                        return path ? `${path}: ${issue.message}` : issue.message
                    }).join('; '),
                },
            }, 400)
        }

        c.set(LIVEQUERY_VARS.body as never, result.value as never)
        await next()
    }
}
