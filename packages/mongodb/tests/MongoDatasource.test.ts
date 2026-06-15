import { describe, expect, test } from 'bun:test'
import { LivequeryRequestParser } from '@livequery/core'
import { ObjectId } from 'mongodb'
import { MongoDatasource } from '../src/MongoDatasource.js'
import { baseRequest, collectionReadResponse, createMockClient, createMockCollection, createMockDb } from './helpers.js'

describe('MongoDatasource core integration', () => {
    test('handle reads ctx.livequery, resolves core route, and assigns ctx.response', async () => {
        const products = createMockCollection('products', collectionReadResponse())
        const db = createMockDb({ products })
        const datasource = new MongoDatasource({ connections: { default: db as any } })

        await datasource.init([
            { method: 'GET', path: '/livequery/products', collection: 'products' },
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
        expect(db.collectionCalls).toEqual(['products'])
        expect(products.aggregateCalls).toHaveLength(1)
    })

    test('handle supports core document route patterns through ctx.request.ref', async () => {
        const id = '507f1f77bcf86cd799439011'
        const products = createMockCollection('products', [{ id, name: 'phone' }])
        const datasource = new MongoDatasource({
            connections: { default: createMockDb({ products }) as any },
        })

        await datasource.init([
            { method: 'GET', path: '/livequery/products/:id', collection: 'products' },
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
        expect(products.aggregateCalls[0][0].$match._id).toEqual(ObjectId.createFromHexString(id))
    })

    test('keeps path-only fallback when method route lookup misses', async () => {
        const products = createMockCollection('products', collectionReadResponse())
        const datasource = new MongoDatasource({
            connections: { default: createMockDb({ products }) as any },
        })

        await datasource.init([
            { method: 'GET', path: '/products', collection: 'products' },
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
            livequery: {
                ref: 'products',
                keys: {},
                method: 'GET',
                query: {},
            },
        }

        await datasource.handle(ctx)
        expect(ctx.response.items).toEqual([])
    })

    test('throws a core error when ctx.livequery is missing', async () => {
        const datasource = new MongoDatasource({ connections: { default: createMockDb({}) as any } })
        await datasource.init([{ method: 'GET', path: '/products', collection: 'products' }])

        await expect(datasource.handle({
            request: {
                method: 'GET',
                path: '/products',
                ref: '/products',
                params: {},
                query: {},
                headers: new Map(),
            },
        } as any)).rejects.toMatchObject({
            status: 400,
            code: 'INVALID_LIVEQUERY_REQUEST',
        })
    })

    test('throws a core error when route options are missing', async () => {
        const datasource = new MongoDatasource({ connections: { default: createMockDb({}) as any } })
        await datasource.init([])

        await expect(datasource.handle({
            request: {
                method: 'GET',
                path: '/missing',
                ref: '/missing',
                params: {},
                query: {},
                headers: new Map(),
            },
            livequery: {
                ref: 'missing',
                keys: {},
                method: 'GET',
                query: {},
            },
        } as any)).rejects.toMatchObject({
            status: 404,
            code: 'ROUTE_OPTIONS_NOT_FOUND',
        })
    })
})

describe('MongoDatasource query and writes', () => {
    test('init(routes) supports direct query reads', async () => {
        const products = createMockCollection('products', collectionReadResponse([{ id: '1', name: 'phone' }]))
        const datasource = new MongoDatasource({ connections: { default: createMockDb({ products }) as any } })

        await datasource.init([
            { method: 'GET', path: '/products', collection: 'products' },
        ])

        const response = await datasource.query(
            baseRequest({ query: { ':limit': 5 } }) as any,
            { collection: 'products' }
        )

        expect(response.items).toEqual([{ id: '1', name: 'phone' }])
        expect(response.count.current).toBe(1)
    })

    test('post merges keys and body and returns inserted id', async () => {
        const products = createMockCollection('products')
        const datasource = new MongoDatasource({ connections: { default: createMockDb({ products }) as any } })

        const response = await datasource.query(
            baseRequest({
                method: 'POST',
                keys: { tenantId: 't1' },
                body: { name: 'phone' },
            }) as any,
            { collection: 'products' }
        )

        expect(products.insertOneCalls[0]).toEqual({ tenantId: 't1', name: 'phone' })
        expect(response.item).toEqual({
            tenantId: 't1',
            name: 'phone',
            _id: undefined,
            id: '507f1f77bcf86cd799439011',
        })
    })

    test('put wraps plain update bodies in $set and converts id key', async () => {
        const id = '507f1f77bcf86cd799439011'
        const products = createMockCollection('products')
        const datasource = new MongoDatasource({ connections: { default: createMockDb({ products }) as any } })

        const response = await datasource.query(
            baseRequest({
                method: 'PUT',
                keys: { id },
                body: { name: 'new phone' },
            }) as any,
            { collection: 'products' }
        )

        expect(products.updateOneCalls[0]).toEqual({
            filter: { _id: ObjectId.createFromHexString(id) },
            update: { $set: { name: 'new phone' } },
        })
        // Normalized write response, not the raw MongoDB UpdateResult.
        expect(response.item).toEqual({ id, name: 'new phone' })
    })

    test('patch passes operator updates through unchanged', async () => {
        const id = '507f1f77bcf86cd799439011'
        const products = createMockCollection('products')
        const datasource = new MongoDatasource({ connections: { default: createMockDb({ products }) as any } })

        await datasource.query(
            baseRequest({
                method: 'PATCH',
                keys: { id },
                body: { $inc: { stock: 1 } },
            }) as any,
            { collection: 'products' }
        )

        expect(products.updateOneCalls[0].update).toEqual({ $inc: { stock: 1 } })
    })

    test('objectIdFields converts top-level keys and body fields', async () => {
        const id = '507f1f77bcf86cd799439011'
        const ownerId = '507f191e810c19729de860ea'
        const products = createMockCollection('products')
        const datasource = new MongoDatasource({ connections: { default: createMockDb({ products }) as any } })

        await datasource.query(
            baseRequest({
                method: 'PATCH',
                keys: { id, ownerId },
                body: { ownerId },
            }) as any,
            {
                collection: 'products',
                objectIdFields: ['ownerId'],
            }
        )

        expect(products.updateOneCalls[0]).toEqual({
            filter: {
                _id: ObjectId.createFromHexString(id),
                ownerId: ObjectId.createFromHexString(ownerId),
            },
            update: {
                $set: {
                    ownerId: ObjectId.createFromHexString(ownerId),
                },
            },
        })
    })

    test('objectIdFields write response returns hex strings, not ObjectId instances', async () => {
        const id = '507f1f77bcf86cd799439011'
        const ownerId = '507f191e810c19729de860ea'
        const products = createMockCollection('products')
        const datasource = new MongoDatasource({ connections: { default: createMockDb({ products }) as any } })

        const response = await datasource.query(
            baseRequest({
                method: 'PATCH',
                keys: { id, ownerId },
                body: { ownerId },
            }) as any,
            { collection: 'products', objectIdFields: ['ownerId'] }
        )

        // The filter is converted to ObjectId (asserted elsewhere), but the API response
        // item must echo plain strings so it matches what the client sent.
        expect(response.item).toEqual({ id, ownerId })
        expect(typeof response.item.ownerId).toBe('string')
        expect(response.item.ownerId).not.toBeInstanceOf(ObjectId)
    })

    test('delete converts id key to _id', async () => {
        const id = '507f1f77bcf86cd799439011'
        const products = createMockCollection('products')
        const datasource = new MongoDatasource({ connections: { default: createMockDb({ products }) as any } })

        const response = await datasource.query(
            baseRequest({
                method: 'DELETE',
                keys: { id },
            }) as any,
            { collection: 'products' }
        )

        expect(products.deleteOneCalls[0]).toEqual({ _id: ObjectId.createFromHexString(id) })
        // Normalized write response, not the raw MongoDB DeleteResult.
        expect(response.item).toEqual({ id })
    })

    test('dynamic connection, database, and collection resolvers choose the native collection', async () => {
        const products = createMockCollection('tenant_products', collectionReadResponse())
        const tenantDb = createMockDb({ tenant_products: products })
        const client = createMockClient({ tenant_t1: tenantDb })
        const datasource = new MongoDatasource({ connections: { t1: client as any } })

        await datasource.query(
            baseRequest({
                keys: { tenantId: 't1' },
            }) as any,
            {
                connection: req => req.keys.tenantId,
                db: req => `tenant_${req.keys.tenantId}`,
                collection: req => `tenant_products`,
            }
        )

        expect(client.dbCalls).toEqual(['tenant_t1'])
        expect(tenantDb.collectionCalls).toEqual(['tenant_products'])
        expect(products.aggregateCalls).toHaveLength(1)
    })

    test('collection handles are cached by connection, database, and collection', async () => {
        const a = createMockCollection('a', collectionReadResponse())
        const b = createMockCollection('b', collectionReadResponse())
        const db = createMockDb({ a, b })
        const datasource = new MongoDatasource({ connections: { default: db as any } })

        await datasource.query(baseRequest() as any, { collection: 'a', db: 'main' })
        await datasource.query(baseRequest() as any, { collection: 'a', db: 'main' })
        await datasource.query(baseRequest() as any, { collection: 'b', db: 'main' })

        expect(db.collectionCalls).toEqual(['a', 'b'])
    })
})
