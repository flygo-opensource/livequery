import { describe, expect, test } from 'bun:test'
import { LivequeryRequestParser } from '@livequery/core'
import { PostgresDatasource } from '../src/PostgresDatasource.js'
import { baseRequest, createMockDb } from './helpers.js'

describe('PostgresDatasource core integration', () => {
    test('handle reads ctx.livequery, resolves core route, and assigns ctx.response', async () => {
        const db = createMockDb({ items: [] })
        const datasource = new PostgresDatasource({ connections: { default: db } })

        await datasource.init([
            { method: 'GET', path: '/livequery/products', table: 'products' },
        ])

        const ctx: any = {
            request: {
                method: 'GET',
                path: '/livequery/products',
                ref: '/livequery/products',
                params: {},
                query: { ':limit': 10 },
                headers: new Map(),
            },
        }

        new LivequeryRequestParser().handle(ctx)
        const response = await datasource.handle(ctx)

        expect(response).toBe(ctx.response)
        expect(ctx.response.items).toEqual([])
        // First query is the windowed SELECT against the qualified table.
        expect(db.queries[0].text).toContain('FROM "public"."products"')
        expect(db.queries[0].text).toContain('LIMIT 10')
    })

    test('handle supports core document route patterns through ctx.request.ref', async () => {
        const id = '11111111-1111-1111-1111-111111111111'
        const db = createMockDb({ items: [{ id, name: 'phone' }] })
        const datasource = new PostgresDatasource({ connections: { default: db } })

        await datasource.init([
            { method: 'GET', path: '/livequery/products/:id', table: 'products' },
        ])

        const ctx: any = {
            request: {
                method: 'GET',
                path: `/livequery/products/${id}`,
                ref: '/livequery/products/:id',
                params: { id },
                query: {},
                headers: new Map(),
            },
        }

        new LivequeryRequestParser().handle(ctx)
        await datasource.handle(ctx)

        expect(ctx.response.item).toEqual({ id, name: 'phone' })
        const select = db.queries[0]
        expect(select.text).toMatch(/SELECT \* FROM "public"."products" WHERE \("id" = \$1\) LIMIT 1/)
        expect(select.values).toEqual([id])
    })

    test('keeps path-only fallback when method route lookup misses', async () => {
        const db = createMockDb({ items: [] })
        const datasource = new PostgresDatasource({ connections: { default: db } })

        await datasource.init([
            { method: 'GET', path: '/products', table: 'products' },
        ])

        const ctx: any = {
            request: {
                method: 'POST',
                path: '/products',
                ref: '/products',
                params: {},
                query: {},
                headers: new Map(),
            },
            livequery: { ref: 'products', keys: {}, method: 'GET', query: {} },
        }

        await datasource.handle(ctx)
        expect(ctx.response.items).toEqual([])
    })

    test('throws a core error when ctx.livequery is missing', async () => {
        const datasource = new PostgresDatasource({ connections: { default: createMockDb() } })
        await datasource.init([{ method: 'GET', path: '/products', table: 'products' }])

        await expect(datasource.handle({
            request: { method: 'GET', path: '/products', ref: '/products', params: {}, query: {}, headers: new Map() },
        } as any)).rejects.toMatchObject({ status: 400, code: 'INVALID_LIVEQUERY_REQUEST' })
    })

    test('throws a core error when route options are missing', async () => {
        const datasource = new PostgresDatasource({ connections: { default: createMockDb() } })
        await datasource.init([])

        await expect(datasource.handle({
            request: { method: 'GET', path: '/missing', ref: '/missing', params: {}, query: {}, headers: new Map() },
            livequery: { ref: 'missing', keys: {}, method: 'GET', query: {} },
        } as any)).rejects.toMatchObject({ status: 404, code: 'ROUTE_OPTIONS_NOT_FOUND' })
    })
})

describe('PostgresDatasource query and writes', () => {
    test('init(routes) supports direct query reads', async () => {
        const db = createMockDb({ items: [{ id: '1', name: 'phone' }], next: 0, prev: 0 })
        const datasource = new PostgresDatasource({ connections: { default: db } })

        await datasource.init([{ method: 'GET', path: '/products', table: 'products' }])

        const response = await datasource.query(
            baseRequest({ query: { ':limit': 5 } }) as any,
            { table: 'products' }
        )

        expect(response.items).toEqual([{ id: '1', name: 'phone' }])
        expect(response.count.current).toBe(1)
    })

    test('post merges keys and body and inserts with RETURNING', async () => {
        const db = createMockDb({ write: { id: '1', tenant_id: 't1', name: 'phone' } })
        const datasource = new PostgresDatasource({ connections: { default: db } })

        const response = await datasource.query(
            baseRequest({ method: 'POST', keys: { tenant_id: 't1' }, body: { name: 'phone' } }) as any,
            { table: 'products' }
        )

        const insert = db.last()
        expect(insert.text).toMatch(/INSERT INTO "public"."products" \("tenant_id", "name"\) VALUES \(\$1, \$2\) RETURNING \*/)
        expect(insert.values).toEqual(['t1', 'phone'])
        expect(response.item).toEqual({ id: '1', tenant_id: 't1', name: 'phone' })
    })

    test('put sets plain body and filters by id key', async () => {
        const id = '11111111-1111-1111-1111-111111111111'
        const db = createMockDb({ write: { id, name: 'new phone' } })
        const datasource = new PostgresDatasource({ connections: { default: db } })

        const response = await datasource.query(
            baseRequest({ method: 'PUT', keys: { id }, body: { name: 'new phone' } }) as any,
            { table: 'products' }
        )

        const update = db.last()
        expect(update.text).toMatch(/UPDATE "public"."products" SET "name" = \$1 WHERE "id" = \$2 RETURNING \*/)
        expect(update.values).toEqual(['new phone', id])
        expect(response.item).toEqual({ id, name: 'new phone' })
    })

    test('patch translates $inc operator bodies to SQL arithmetic', async () => {
        const id = '11111111-1111-1111-1111-111111111111'
        const db = createMockDb({ write: { id, stock: 6 } })
        const datasource = new PostgresDatasource({ connections: { default: db } })

        await datasource.query(
            baseRequest({ method: 'PATCH', keys: { id }, body: { $inc: { stock: 1 } } }) as any,
            { table: 'products' }
        )

        const update = db.last()
        expect(update.text).toMatch(/SET "stock" = "stock" \+ \$1 WHERE "id" = \$2/)
        expect(update.values).toEqual([1, id])
    })

    test('delete filters by id key with RETURNING', async () => {
        const id = '11111111-1111-1111-1111-111111111111'
        const db = createMockDb({ write: { id, name: 'phone' } })
        const datasource = new PostgresDatasource({ connections: { default: db } })

        const response = await datasource.query(
            baseRequest({ method: 'DELETE', keys: { id } }) as any,
            { table: 'products' }
        )

        const del = db.last()
        expect(del.text).toMatch(/DELETE FROM "public"."products" WHERE "id" = \$1 RETURNING \*/)
        expect(del.values).toEqual([id])
        expect(response.item).toEqual({ id, name: 'phone' })
    })

    test('custom idField maps id <-> physical primary key on read and write', async () => {
        const db = createMockDb({ items: [{ user_id: 'u1', name: 'a' }], write: { user_id: 'u1', name: 'b' } })
        const datasource = new PostgresDatasource({ connections: { default: db } })

        // Document read: WHERE uses the physical column, response exposes `id`.
        const read = await datasource.query(
            baseRequest({ is_collection: false, keys: { id: 'u1' } }) as any,
            { table: 'users', idField: 'user_id' }
        )
        expect(db.queries[0].text).toMatch(/WHERE \("user_id" = \$1\)/)
        expect(read.item).toEqual({ id: 'u1', name: 'a' })

        // Write: id key maps onto user_id, response row maps user_id back to id.
        const write = await datasource.query(
            baseRequest({ method: 'PUT', keys: { id: 'u1' }, body: { name: 'b' } }) as any,
            { table: 'users', idField: 'user_id' }
        )
        expect(db.last().text).toMatch(/WHERE "user_id" = \$2/)
        expect(write.item).toEqual({ id: 'u1', name: 'b' })
    })

    test('dynamic connection, schema, and table resolvers choose the executor and qualified name', async () => {
        const tenantDb = createMockDb({ items: [] })
        const datasource = new PostgresDatasource({ connections: { t1: tenantDb } })

        await datasource.query(
            baseRequest({ keys: { tenantId: 't1' } }) as any,
            {
                connection: req => req.keys.tenantId,
                schema: req => `tenant_${req.keys.tenantId}`,
                table: () => 'products',
            }
        )

        expect(tenantDb.queries[0].text).toContain('FROM "tenant_t1"."products"')
    })

    test('table descriptors are cached by connection, schema, table, and idField', async () => {
        const db = createMockDb({ items: [] })
        const datasource = new PostgresDatasource({ connections: { default: db } })

        await datasource.query(baseRequest() as any, { table: 'a', schema: 'public' })
        await datasource.query(baseRequest() as any, { table: 'a', schema: 'public' })
        await datasource.query(baseRequest() as any, { table: 'b', schema: 'public' })

        // Three reads (each: SELECT + COUNT only when items exist -> here items empty so just SELECT).
        const selects = db.queries.filter(q => /^SELECT \* FROM/.test(q.text))
        expect(selects.map(q => q.text.match(/FROM ("public"\."[ab]")/)![1])).toEqual([
            '"public"."a"', '"public"."a"', '"public"."b"',
        ])
    })
})
