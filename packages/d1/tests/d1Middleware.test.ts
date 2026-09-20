import { describe, expect, test } from 'bun:test'
import { LIVEQUERY_VARS, LivequeryRequestParser } from '@livequery/core'
import { d1 } from '../src/d1.js'
import { createMockD1, type MockD1Database } from './helpers.js'

type FakeContext = ReturnType<typeof makeContext>

function makeContext(method: string, path: string, ref: string, db: MockD1Database, body?: unknown) {
    const url = new URL(`http://service${path}`)
    // Match every :param in the route pattern against the actual path, like a router would.
    const pattern_segments = ref.split('/').filter(Boolean)
    const path_segments = url.pathname.split('/').filter(Boolean)
    const params = Object.fromEntries(pattern_segments.flatMap((segment, index) =>
        segment.startsWith(':') ? [[segment.slice(1), path_segments[index] as string]] : []))
    const request = LivequeryRequestParser.parse({
        path: url.pathname,
        ref,
        method,
        params,
        query: Object.fromEntries(url.searchParams),
        body,
        headers: new Map(),
    })
    const vars = new Map<string, unknown>([[LIVEQUERY_VARS.request, request]])
    let response: Response | undefined
    return {
        env: { DB: db },
        req: { method },
        get finalized() { return response !== undefined },
        get res() { return response as Response },
        set res(value: Response) { response = value },
        get: (key: string) => vars.get(key),
        set: (key: string, value: unknown) => { vars.set(key, value) },
        json: (value: unknown, status = 200) => {
            response = Response.json(value, { status })
            return response
        },
        answer: (value: unknown, status: number) => {
            response = Response.json(value, { status })
        },
    }
}

const run = (context: FakeContext, options = {}, next = async () => {}) =>
    d1(options)(context as never, next)

// ─── operations ────────────────────────────────────────────────────────────────

describe('d1() middleware', () => {
    test('collection GET lists and publishes the result before next()', async () => {
        const db = createMockD1({ items: [{ id: 't1', title: 'a' }], count: 1 })
        const c = makeContext('GET', '/livequery/tasks', '/livequery/tasks', db)
        let seen: unknown
        const response = await run(c, {}, async () => { seen = c.get(LIVEQUERY_VARS.result) })

        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ items: [{ id: 't1' }] })
        expect(seen).toMatchObject({ items: [{ id: 't1' }] })
        expect(db.queries[0].sql).toContain('FROM tasks')
    })

    test('document GET reads one row', async () => {
        const db = createMockD1({ first: { id: 't1', title: 'a' } })
        const c = makeContext('GET', '/livequery/tasks/t1', '/livequery/tasks/:id', db)
        const response = await run(c)
        expect(await response.json()).toEqual({ item: { id: 't1', title: 'a' } })
    })

    test('POST inserts and answers 201', async () => {
        const db = createMockD1()
        const c = makeContext('POST', '/livequery/tasks', '/livequery/tasks', db, { title: 'a' })
        const response = await run(c)
        expect(response.status).toBe(201)
        expect(db.last().sql).toStartWith('INSERT INTO tasks')
    })

    test('PATCH updates and DELETE removes', async () => {
        const patch_db = createMockD1({ first: { id: 't1' } })
        await run(makeContext('PATCH', '/livequery/tasks/t1', '/livequery/tasks/:id', patch_db, { title: 'b' }))
        expect(patch_db.last().sql).toStartWith('UPDATE tasks SET title = ?')

        const delete_db = createMockD1({ first: { id: 't1' } })
        await run(makeContext('DELETE', '/livequery/tasks/t1', '/livequery/tasks/:id', delete_db))
        expect(delete_db.last().sql).toStartWith('DELETE FROM tasks')
    })

    test('a downstream middleware may answer instead', async () => {
        const db = createMockD1({ items: [], count: 0 })
        const c = makeContext('GET', '/livequery/tasks', '/livequery/tasks', db)
        const response = await run(c, {}, async () => { c.answer({ replaced: true }, 202) })
        expect(response.status).toBe(202)
        expect(await response.json()).toEqual({ replaced: true })
    })
})

// ─── configuration and safety ──────────────────────────────────────────────────

describe('d1() configuration', () => {
    test('table defaults to the collection ref, and can be overridden', async () => {
        const db = createMockD1({ items: [], count: 0 })
        await run(makeContext('GET', '/livequery/tasks', '/livequery/tasks', db))
        expect(db.queries[0].sql).toContain('FROM tasks')

        const named = createMockD1({ items: [], count: 0 })
        await run(makeContext('GET', '/livequery/tasks', '/livequery/tasks', named), { table: 'task_items' })
        expect(named.queries[0].sql).toContain('FROM task_items')
    })

    test('nested routes use the last collection segment', async () => {
        const db = createMockD1({ items: [], count: 0 })
        const c = makeContext(
            'GET',
            '/livequery/customers/c1/orders',
            '/livequery/customers/:customer_id/orders',
            db,
        )
        await run(c)
        expect(db.queries[0].sql).toContain('FROM orders')
        expect(db.queries[0].sql).toContain('WHERE customer_id = ?')
    })

    test('the validator schema becomes the column allowlist', async () => {
        const db = createMockD1()
        const c = makeContext('GET', '/livequery/tasks?secret=1', '/livequery/tasks', db)
        c.set(LIVEQUERY_VARS.schema, { shape: { title: {}, status: {} } })
        await expect(run(c)).rejects.toMatchObject({ code: 'FIELD_NOT_ALLOWED' })
    })

    test('a missing binding or livequery() is a programming error', async () => {
        const db = createMockD1()
        const c = makeContext('GET', '/livequery/tasks', '/livequery/tasks', db)
        await expect(run(c, { binding: 'OTHER_DB' })).rejects.toThrow('no D1 binding named "OTHER_DB"')

        const bare = { ...makeContext('GET', '/livequery/tasks', '/livequery/tasks', db), get: () => undefined }
        await expect(run(bare as never)).rejects.toThrow('requires livequery()')
    })

    test('a failing query throws, so nothing downstream runs', async () => {
        const db = createMockD1()
        const c = makeContext('GET', '/livequery/tasks?1=1 OR id', '/livequery/tasks', db)
        let ran = false
        await expect(run(c, {}, async () => { ran = true })).rejects.toMatchObject({ code: 'INVALID_FIELD' })
        expect(ran).toBe(false)
    })
})
