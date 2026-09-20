import { describe, expect, test } from 'bun:test'
import { Cursor } from '../src/Cursor.js'
import { D1Query } from '../src/D1Query.js'
import { baseRequest, createMockD1 } from './helpers.js'

const INJECTIONS = [
    '1=1 OR id',
    'title = ? OR 1=1 OR title',
    'id IN (SELECT name FROM sqlite_master) OR id',
    'title;DROP TABLE tasks',
    'title--',
    '"title"',
]

// ─── identifiers ───────────────────────────────────────────────────────────────

describe('D1Query identifier validation', () => {
    for (const field of INJECTIONS) {
        test(`filter key ${JSON.stringify(field)} — rejected before any SQL runs`, async () => {
            const db = createMockD1()
            await expect(D1Query.queryCollection(db, 'tasks', baseRequest({ query: { [field]: 'x' } }) as any))
                .rejects.toMatchObject({ status: 400, code: 'INVALID_FIELD' })
            expect(db.queries).toHaveLength(0)
        })
    }

    test('operator, like and sort keys are validated', async () => {
        const db = createMockD1()
        for (const key of ['1=1 OR id:eq', '1=1 OR id:like', 'id DESC, (SELECT 1):sort']) {
            await expect(D1Query.queryCollection(db, 'tasks', baseRequest({ query: { [key]: 'x' } }) as any))
                .rejects.toMatchObject({ status: 400, code: 'INVALID_FIELD' })
        }
        expect(db.queries).toHaveLength(0)
    })

    test('body keys are validated on insert and update', async () => {
        const db = createMockD1()
        await expect(D1Query.insert(db, 'tasks', { 'title) VALUES (1); --': 'x' }))
            .rejects.toMatchObject({ code: 'INVALID_FIELD' })
        await expect(D1Query.update(db, 'tasks', 't1', { 'title = 1, status': 'x' }))
            .rejects.toMatchObject({ code: 'INVALID_FIELD' })
        expect(db.queries).toHaveLength(0)
    })

    test('route keys and table names are validated', async () => {
        const db = createMockD1()
        await expect(D1Query.delete(db, 'tasks', 't1', { 'tenant_id OR 1': 'x' }))
            .rejects.toMatchObject({ code: 'INVALID_FIELD' })
        await expect(D1Query.queryDocument(db, 'tasks; DROP TABLE x', baseRequest({ keys: { id: 't1' } }) as any))
            .rejects.toThrow('Invalid D1 table name')
        expect(db.queries).toHaveLength(0)
    })

    test('unknown operator — rejected instead of silently ignored', async () => {
        const db = createMockD1()
        await expect(D1Query.queryCollection(db, 'tasks', baseRequest({ query: { 'title:regex': 'x' } }) as any))
            .rejects.toMatchObject({ status: 400, code: 'INVALID_OPERATOR' })
    })

    test('IN list above the D1 parameter budget — rejected', async () => {
        const db = createMockD1()
        const values = Array.from({ length: 51 }, (_, i) => `v${i}`)
        await expect(D1Query.queryCollection(db, 'tasks', baseRequest({ query: { 'id:in': values } }) as any))
            .rejects.toMatchObject({ status: 400, code: 'TOO_MANY_VALUES' })
    })

    test('cursor values stay bound parameters', async () => {
        const db = createMockD1({ items: [], count: 0 })
        const after = Cursor.encode({ id: "x') OR 1=1 --", title: 'a' })
        const query = { ':after': after, 'title:sort': 'asc' }
        await D1Query.queryCollection(db, 'tasks', baseRequest({ query }) as any)
        expect(db.queries[0].sql).not.toContain('OR 1=1')
        expect(db.queries[0].values).toContain("x') OR 1=1 --")
    })

    test('valid filters still produce the same SQL', async () => {
        const db = createMockD1({ items: [], count: 0 })
        await D1Query.queryCollection(db, 'tasks', baseRequest({
            keys: { tenant_id: 't1' },
            query: { status: 'open', 'priority:gte': '2', 'title:like': 'bug', 'created_at:sort': 'desc' },
        }) as any)
        expect(db.queries[0]).toEqual({
            sql: 'SELECT * FROM tasks WHERE tenant_id = ? AND status = ? AND priority >= ? '
                + 'AND LOWER(title) LIKE LOWER(?) ORDER BY created_at DESC, id DESC LIMIT ?',
            values: ['t1', 'open', 2, '%bug%', 11],
        })
    })
})

// ─── allowlist ─────────────────────────────────────────────────────────────────

describe('D1Query fields allowlist', () => {
    const fields = ['title', 'status']

    test('filter and sort on a column outside the allowlist — rejected', async () => {
        const db = createMockD1()
        await expect(D1Query.queryCollection(db, 'tasks', baseRequest({ query: { secret: 'x' } }) as any, fields))
            .rejects.toMatchObject({ status: 400, code: 'FIELD_NOT_ALLOWED' })
        const sort_request = baseRequest({ query: { 'secret:sort': 'asc' } }) as any
        await expect(D1Query.queryCollection(db, 'tasks', sort_request, fields))
            .rejects.toMatchObject({ status: 400, code: 'FIELD_NOT_ALLOWED' })
    })

    test('write to a column outside the allowlist — rejected, id always allowed', async () => {
        const db = createMockD1()
        await expect(D1Query.insert(db, 'tasks', { title: 'a', is_admin: 1 }, fields))
            .rejects.toMatchObject({ code: 'FIELD_NOT_ALLOWED' })
        await D1Query.insert(db, 'tasks', { title: 'a', id: 't1' }, fields)
        expect(db.last().sql).toBe('INSERT INTO tasks (title, id) VALUES (?, ?)')
    })

    test('route keys bypass the allowlist for filters', async () => {
        const db = createMockD1({ items: [], count: 0 })
        await D1Query.queryCollection(db, 'tasks', baseRequest({ keys: { tenant_id: 't1' } }) as any, fields)
        expect(db.queries[0].sql).toContain('WHERE tenant_id = ?')
    })
})
