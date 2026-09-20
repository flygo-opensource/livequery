import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { LIVEQUERY_VARS, type RealtimeSubscription, type UpdatedData } from '@livequery/core'
import {
    LIVEQUERY_CHANGE_HEADER,
    LIVEQUERY_REF_HEADER,
    livequery,
    realtime,
    validator,
    type LivequerySchema,
} from '../src/index.js'

// A tiny Standard Schema object, so the test needs no validation library.
function schema(fields: Record<string, 'string' | 'number'>, defaults: Record<string, unknown> = {}): LivequerySchema {
    const self: LivequerySchema = {
        shape: Object.fromEntries(Object.keys(fields).map(key => [key, {}])),
        partial: () => ({ ...self, '~standard': { validate: (value: unknown) => ({ value }) } }),
        '~standard': {
            validate(value: unknown) {
                if (typeof value !== 'object' || value === null) {
                    return { issues: [{ message: 'expected an object' }] }
                }
                const input = value as Record<string, unknown>
                const issues = Object.entries(fields).flatMap(([key, kind]) =>
                    input[key] !== undefined && typeof input[key] !== kind
                        ? [{ message: `expected ${kind}`, path: [key] }]
                        : [])
                if (issues.length > 0) return { issues }
                return { value: { ...defaults, ...input } }
            },
        },
    }
    return self
}

const Task = schema({ title: 'string', status: 'string' }, { status: 'todo' })

/** Stands in for a datasource middleware: records the request, publishes a result, then next(). */
function fakeSource(result: unknown) {
    return async (c: any, next: () => Promise<void>) => {
        c.set(LIVEQUERY_VARS.result, result)
        c.res = c.json(result, c.req.method === 'POST' ? 201 : 200)
        await next()
        return c.res
    }
}

// ─── validator ─────────────────────────────────────────────────────────────────

describe('validator()', () => {
    test('rejects a body that does not match, with the failing field', async () => {
        const app = new Hono()
        app.post('/livequery/tasks', validator(Task), livequery(), fakeSource({ item: { id: 't1' } }))

        const res = await app.request('/livequery/tasks', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: 42 }),
        })
        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({ error: { code: 'VALIDATION_FAILED', message: 'title: expected string' } })
    })

    test('livequery() sees the validated body, so schema defaults survive', async () => {
        const app = new Hono()
        let body: unknown
        app.post('/livequery/tasks', validator(Task), livequery(), async c => {
            body = (c.get(LIVEQUERY_VARS.request as never) as any).body
            return c.json({ ok: true })
        })

        await app.request('/livequery/tasks', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'write docs' }),
        })
        expect(body).toEqual({ status: 'todo', title: 'write docs' })
    })

    test('PATCH validates against the partial schema', async () => {
        const app = new Hono()
        app.patch('/livequery/tasks/:id', validator(Task), livequery(), fakeSource({ item: { id: 't1' } }))

        const res = await app.request('/livequery/tasks/t1', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ status: 'done' }),   // `title` missing on purpose
        })
        expect(res.status).toBe(200)
    })

    test('GET carries no body: the schema is published for the allowlist only', async () => {
        const app = new Hono()
        let published: unknown
        app.get('/livequery/tasks', validator(Task), livequery(), async c => {
            published = c.get(LIVEQUERY_VARS.schema as never)
            return c.json({ items: [] })
        })

        const res = await app.request('/livequery/tasks')
        expect(res.status).toBe(200)
        expect(published).toBe(Task)
    })

    test('malformed JSON — 400 before anything reads the body', async () => {
        const app = new Hono()
        app.post('/livequery/tasks', validator(Task), livequery(), fakeSource({ item: { id: 't1' } }))

        const res = await app.request('/livequery/tasks', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{ not json',
        })
        expect(res.status).toBe(400)
        expect(await res.json()).toMatchObject({ error: { code: 'INVALID_JSON' } })
    })
})

// ─── realtime ──────────────────────────────────────────────────────────────────

describe('realtime()', () => {
    const app = (target?: Parameters<typeof realtime>[0]) => {
        const hono = new Hono()
        hono.get('/livequery/tasks', livequery(), fakeSource({ items: [] }), realtime(target))
        hono.get('/livequery/tasks/:id', livequery(), fakeSource({ item: { id: 't1' } }), realtime(target))
        hono.post('/livequery/tasks', livequery(), fakeSource({ item: { id: 't1' } }), realtime(target))
        hono.delete('/livequery/tasks/:id', livequery(), fakeSource({ item: { id: 't1' } }), realtime(target))
        return hono
    }

    test('header mode annotates the response for the gateway', async () => {
        const read = await app().request('/livequery/tasks/t1', { headers: { 'x-lcid': 'c1' } })
        expect(read.headers.get(LIVEQUERY_REF_HEADER)).toBe('tasks/t1')

        const write = await app().request('/livequery/tasks', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'a' }),
        })
        expect(write.status).toBe(201)
        expect(write.headers.get(LIVEQUERY_CHANGE_HEADER)).toBe('added tasks')

        const removed = await app().request('/livequery/tasks/t1', { method: 'DELETE' })
        expect(removed.headers.get(LIVEQUERY_CHANGE_HEADER)).toBe('removed tasks')
    })

    test('a read without x-lcid is not annotated', async () => {
        const res = await app().request('/livequery/tasks/t1')
        expect(res.headers.get(LIVEQUERY_REF_HEADER)).toBeNull()
    })

    test('a paginating read is not subscribed again', async () => {
        const res = await app().request('/livequery/tasks?:after=abc', { headers: { 'x-lcid': 'c1' } })
        expect(res.headers.get(LIVEQUERY_REF_HEADER)).toBeNull()
    })

    test('in-process gateway mode registers and publishes directly', async () => {
        const listened: RealtimeSubscription[][] = []
        const published: UpdatedData[] = []
        const gateway = { id: 'gw-1', listen: (e: RealtimeSubscription[]) => listened.push(e), next: (u: UpdatedData) => published.push(u) }

        await app(gateway).request('/livequery/tasks', { headers: { 'x-lcid': 'c1' } })
        expect(listened).toEqual([[{ ref: 'tasks', client_id: 'c1', gateway_id: 'gw-1', listener_node_id: 'gw-1' }]])

        await app(gateway).request('/livequery/tasks', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'a' }),
        })
        expect(published).toEqual([{ ref: 'tasks', type: 'added', data: { id: 't1' } }])
    })

    test('function mode hands the work to a publisher, as on Workers', async () => {
        const calls: unknown[] = []
        const target = {
            register: (subscription: RealtimeSubscription) => { calls.push(['register', subscription]) },
            publish: (update: UpdatedData) => { calls.push(['publish', update]) },
        }

        await app(target).request('/livequery/tasks', { headers: { 'x-lcid': 'c1', 'x-lgid': 'do-1' } })
        await app(target).request('/livequery/tasks', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'a' }),
        })

        expect(calls).toEqual([
            ['register', { ref: 'tasks', client_id: 'c1', gateway_id: 'do-1', listener_node_id: 'do-1' }],
            ['publish', { ref: 'tasks', type: 'added', data: { id: 't1' } }],
        ])
    })

    test('a failing publisher does not fail the request', async () => {
        const target = { publish: () => { throw new Error('Durable Object unreachable') } }
        const res = await app(target).request('/livequery/tasks', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'a' }),
        })
        expect(res.status).toBe(201)
    })
})
