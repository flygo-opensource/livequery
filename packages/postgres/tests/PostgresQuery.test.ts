import { describe, expect, test } from 'bun:test'
import { PostgresQuery } from '../src/PostgresQuery.js'
import { Cursor } from '../src/Cursor.js'
import { createMockDb, baseRequest } from './helpers.js'

const table = (db: any, extra: Record<string, any> = {}) => ({
    db,
    name: '"public"."products"',
    idField: 'id',
    ...extra,
})

describe('PostgresQuery filters', () => {
    test('translates comparison, like, in, and null operators with bound params', async () => {
        const db = createMockDb({ items: [], next: 0, prev: 0 })
        await PostgresQuery.query(baseRequest({
            query: {
                status: 'active',
                'price:gte': 10,
                'price:lte': 100,
                'name:like': 'pho ne',
                'tag:in': '["a","b"]',
                'deleted_at:eq-null': '1',
            },
        }) as any, table(db))

        const select = db.queries[0]
        expect(select.text).toContain('"status" = $1')
        expect(select.text).toContain('"price" >= $2')
        expect(select.text).toContain('"price" <= $3')
        expect(select.text).toContain('"name" ILIKE $4')
        expect(select.text).toContain('"tag" = ANY($5)')
        expect(select.text).toContain('"deleted_at" IS NULL')
        expect(select.values).toEqual(['active', 10, 100, '%pho ne%', ['a', 'b']])
    })

    test('combines :or and :not logical groups', async () => {
        const db = createMockDb({ items: [], next: 0, prev: 0 })
        await PostgresQuery.query(baseRequest({
            query: {
                ':or': { status: 'a', kind: 'b' },
                ':not': { archived: 'true' },
            },
        }) as any, table(db))

        const text = db.queries[0].text
        expect(text).toMatch(/\("status" = \$\d+ OR "kind" = \$\d+\)/)
        expect(text).toMatch(/NOT \("archived" = \$\d+\)/)
    })

    test('rejects injection attempts in field names', async () => {
        const db = createMockDb({ items: [] })
        await expect(
            PostgresQuery.query(baseRequest({ query: { 'x");DROP TABLE u;--': '1' } }) as any, table(db))
        ).rejects.toMatchObject({ status: 400, code: 'INVALID_FIELD' })
    })
})

describe('PostgresQuery sorting and paging', () => {
    test('builds ORDER BY with id as the final tiebreaker (default desc)', async () => {
        const db = createMockDb({ items: [], next: 0, prev: 0 })
        await PostgresQuery.query(baseRequest({ query: { 'price:sort': 'asc' } }) as any, table(db))
        expect(db.queries[0].text).toContain('ORDER BY "price" ASC, "id" DESC')
    })

    test('after cursor adds a keyset predicate', async () => {
        const db = createMockDb({ items: [{ id: '5', price: 50 }], next: 2, prev: 3 })
        const cursor = Cursor.caculate({ id: '9', price: 90 }, { 'price:sort': 'asc' })
        const result = await PostgresQuery.query(baseRequest({
            query: { 'price:sort': 'asc', ':after': cursor, ':limit': 1 },
        }) as any, table(db))

        const select = db.queries[0]
        // Keyset with price ASC + id DESC (default tiebreaker): (price > c) OR (price = c AND id < cid)
        expect(select.text).toMatch(/"price" > \$1/)
        expect(select.text).toMatch(/"price" = \$2 AND "id" < \$3/)
        expect(select.values).toEqual([90, 90, '9'])
        expect(result.count).toEqual({ prev: 3, next: 2 })
        expect(result.has).toEqual({ prev: true, next: true })
    })

    test('offset paging uses LIMIT/OFFSET and a total count', async () => {
        const db = createMockDb({ items: [{ id: '1' }], total: 25 })
        const result = await PostgresQuery.query(baseRequest({
            query: { ':page': 2, ':limit': 10 },
        }) as any, table(db))

        const select = db.queries.find(q => /LIMIT 10 OFFSET 10/.test(q.text))
        expect(select).toBeDefined()
        expect(db.queries.some(q => /count\(\*\)::int AS total/.test(q.text))).toBe(true)
        expect(result.count).toEqual({ prev: 10, next: 5 })
        expect(result.has).toEqual({ prev: true, next: true })
    })
})

describe('PostgresQuery summary', () => {
    test('single aggregate with no grouping returns a scalar', async () => {
        const db = createMockDb({ items: [] })
        db.responder = (text) => {
            if (/sum\(/.test(text)) return [{ sum_price: 300 }]
            return []
        }
        const result = await PostgresQuery.query(baseRequest({
            query: { '::totals': 'sum(price)' },
        }) as any, table(db))

        const summaryQuery = db.find(/sum\(/)!
        expect(summaryQuery.text).toContain('sum("price"::numeric)::float8 AS "sum_price"')
        expect(result.summary).toEqual({ totals: 300 })
    })

    test('grouped aggregate returns rows', async () => {
        const db = createMockDb({ items: [] })
        const grouped = [{ category: 'a', sum_price: 10 }, { category: 'b', sum_price: 20 }]
        db.responder = (text) => (/GROUP BY/.test(text) ? grouped : [])
        const result = await PostgresQuery.query(baseRequest({
            query: { '::byCat': 'category|sum(price)' },
        }) as any, table(db))

        const summaryQuery = db.find(/GROUP BY/)!
        expect(summaryQuery.text).toContain('GROUP BY "category"')
        expect(summaryQuery.text).toContain('LIMIT 50')
        expect(result.summary).toEqual({ byCat: grouped })
    })
})
