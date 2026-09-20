import { describe, expect, test } from 'bun:test'
import {
    LivequeryRequestParser,
    type LivequeryDatasource as CoreLivequeryDatasource,
} from '@livequery/core'
import { D1Datasource } from '../src/D1Datasource.js'
import type { D1RouteOptions } from '../src/types.js'
import { baseRequest, createMockD1 } from './helpers.js'

describe('D1Datasource core integration', () => {
    test('implements LivequeryDatasource, resolves a route, and assigns ctx.response', async () => {
        const db = createMockD1({ items: [], count: 0 })
        const datasource: CoreLivequeryDatasource<D1RouteOptions> = new D1Datasource({
            databases: { default: db },
        })

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
        expect(db.queries[0].sql).toContain('FROM products')
        expect(db.queries[0].sql).toContain('LIMIT ?')
    })

    test('supports document routes through ctx.request.ref', async () => {
        const db = createMockD1({ first: { id: 'p1', name: 'phone' } })
        const datasource = new D1Datasource({ databases: { default: db } })
        await datasource.init([
            { method: 'GET', path: '/livequery/products/:id', table: 'products' },
        ])

        const ctx: any = {
            request: {
                method: 'GET',
                path: '/livequery/products/p1',
                ref: '/livequery/products/:id',
                params: { id: 'p1' },
                query: {},
                headers: new Map(),
            },
        }

        new LivequeryRequestParser().handle(ctx)
        await datasource.handle(ctx)

        expect(ctx.response.item).toEqual({ id: 'p1', name: 'phone' })
        expect(db.last()).toEqual({
            sql: 'SELECT * FROM products WHERE id = ? LIMIT 1',
            values: ['p1'],
        })
    })

    test('keeps the path-only route fallback', async () => {
        const db = createMockD1({ items: [], count: 0 })
        const datasource = new D1Datasource({ databases: { default: db } })
        await datasource.init([{ method: 'GET', path: '/products', table: 'products' }])

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

    test('reports missing parsed request and missing route using core errors', async () => {
        const datasource = new D1Datasource({ databases: { default: createMockD1() } })
        await datasource.init([])

        await expect(datasource.handle({
            request: {
                method: 'GET', path: '/products', ref: '/products', params: {}, query: {}, headers: new Map(),
            },
        } as any)).rejects.toMatchObject({ status: 400, code: 'INVALID_LIVEQUERY_REQUEST' })

        await expect(datasource.handle({
            request: {
                method: 'GET', path: '/missing', ref: '/missing', params: {}, query: {}, headers: new Map(),
            },
            livequery: { ref: 'missing', keys: {}, method: 'GET', query: {} },
        } as any)).rejects.toMatchObject({ status: 404, code: 'ROUTE_OPTIONS_NOT_FOUND' })
    })
})

describe('D1Datasource database resolution and compatibility', () => {
    test('standard query dispatches writes through the configured D1 binding', async () => {
        const db = createMockD1()
        const datasource = new D1Datasource({ databases: { default: db } })

        const response = await datasource.query(
            baseRequest({ method: 'POST', keys: { tenant_id: 't1' }, body: { name: 'phone' } }) as any,
            { table: 'products' },
        )

        expect('item' in response && response.item).toMatchObject({ tenant_id: 't1', name: 'phone' })
        expect(db.last().sql).toBe('INSERT INTO products (tenant_id, name, id) VALUES (?, ?, ?)')
        expect(db.last().values[0]).toBe('t1')
        expect(db.last().values[1]).toBe('phone')
        expect(typeof db.last().values[2]).toBe('string')
    })

    test('selects a named database with a route resolver', async () => {
        const defaultDb = createMockD1({ first: { id: 'p1', source: 'default' } })
        const tenantDb = createMockD1({ first: { id: 'p1', source: 'tenant' } })
        const datasource = new D1Datasource({ databases: { default: defaultDb, tenant: tenantDb } })

        const response = await datasource.query(
            baseRequest({ is_collection: false, document_id: 'p1', keys: { id: 'p1' } }) as any,
            { table: 'products', database: () => 'tenant' },
        )

        expect('item' in response && response.item).toEqual({ id: 'p1', source: 'tenant' })
        expect(defaultDb.queries).toHaveLength(0)
        expect(tenantDb.queries).toHaveLength(1)
    })

    test('reports missing config and missing named D1 bindings', async () => {
        await expect(new D1Datasource().query(
            baseRequest() as any,
            { table: 'products' },
        )).rejects.toMatchObject({ status: 500, code: 'DB_CONFIG_NOT_FOUND' })

        await expect(new D1Datasource({ databases: {} }).query(
            baseRequest() as any,
            { table: 'products', database: 'missing' },
        )).rejects.toMatchObject({ status: 500, code: 'DB_CONNECTION_NOT_FOUND' })
    })

    test('retains direct query(db, request, options) for per-request Worker bindings', async () => {
        const db = createMockD1({ first: { id: 'p1', name: 'phone' } })
        const datasource = new D1Datasource()

        const response = await datasource.query(
            db,
            baseRequest({ is_collection: false, document_id: 'p1', keys: { id: 'p1' } }) as any,
            { table: 'products' },
        )

        expect('item' in response && response.item).toEqual({ id: 'p1', name: 'phone' })
    })
})

describe('D1Datasource fields allowlist', () => {
    test('route keys are writable on insert even when absent from fields', async () => {
        const db = createMockD1()
        const datasource = new D1Datasource({ databases: { default: db } })

        await datasource.query(
            baseRequest({ method: 'POST', keys: { tenant_id: 't1' }, body: { name: 'phone' } }) as any,
            { table: 'products', fields: ['name'] },
        )
        expect(db.last().sql).toBe('INSERT INTO products (tenant_id, name, id) VALUES (?, ?, ?)')

        await expect(datasource.query(
            baseRequest({ method: 'POST', body: { name: 'phone', price: 0 } }) as any,
            { table: 'products', fields: ['name'] },
        )).rejects.toMatchObject({ status: 400, code: 'FIELD_NOT_ALLOWED' })
    })
})
