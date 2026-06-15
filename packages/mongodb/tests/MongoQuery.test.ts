import { describe, expect, test } from 'bun:test'
import { ObjectId } from 'mongodb'
import { MongoQuery } from '../src/MongoQuery.js'
import { baseRequest, collectionReadResponse, createMockCollection } from './helpers.js'

describe('MongoQuery.query', () => {
    test('builds collection aggregation with sort, filters, search, id rename, and cursor paging', async () => {
        const collection = createMockCollection('products', collectionReadResponse())
        const ownerId = '507f1f77bcf86cd799439011'

        const response = await MongoQuery.query(
            baseRequest({
                query: {
                    status: 'active',
                    'price:gte': '10',
                    'ownerId:eq-oid': ownerId,
                    ':search': 'phone',
                    ':limit': '20',
                    'price:sort': 'asc',
                },
            }),
            collection as any
        )

        expect(response.limit).toBe(20)
        const pipeline = collection.aggregateCalls[0]

        expect(pipeline[0]).toEqual({ $sort: { price: 1, _id: -1 } })
        expect(pipeline[1]).toEqual({
            $match: {
                status: { $eq: 'active' },
                price: { $gte: 10 },
                ownerId: { $eq: new ObjectId(ownerId) },
            },
        })
        expect(pipeline[2]).toEqual({ $match: { $text: { $search: 'phone' } } })
        expect(pipeline[3]).toEqual({ $set: { id: '$_id' } })
        expect(pipeline[4].$facet).toBeDefined()
    })

    test('cursor paging uses a non-empty topN sortBy after _id is projected to id', async () => {
        const collection = createMockCollection('products', collectionReadResponse())

        await MongoQuery.query(baseRequest(), collection as any)

        const facetStage = collection.aggregateCalls[0].find((s: any) => s.$facet)
        const groupStage = facetStage.$facet.next.find((s: any) => s.$group)
        expect(groupStage.$group.items.$topN.sortBy).toEqual({ id: -1 })
    })

    test('clamps limit to the supported range', async () => {
        const collection = createMockCollection('products', collectionReadResponse())

        expect((await MongoQuery.query(baseRequest({ query: { ':limit': '0' } }), collection as any)).limit).toBe(1)
        expect((await MongoQuery.query(baseRequest({ query: { ':limit': '101' } }), collection as any)).limit).toBe(100)
        expect((await MongoQuery.query(baseRequest({ query: { ':limit': 'x' } }), collection as any)).limit).toBe(10)
    })

    test('builds in and nin filters from JSON strings or arrays', async () => {
        const jsonCollection = createMockCollection('products', collectionReadResponse())
        const arrayCollection = createMockCollection('products', collectionReadResponse())

        await MongoQuery.query(
            baseRequest({
                query: {
                    'status:in': '["active","pending"]',
                    'category:nin': '["archived"]',
                },
            }),
            jsonCollection as any
        )

        await MongoQuery.query(
            baseRequest({
                query: {
                    'status:in': ['active', 'pending'],
                    'category:nin': ['archived'],
                },
            }),
            arrayCollection as any
        )

        const expectedMatch = {
            $match: {
                status: { $in: ['active', 'pending'] },
                category: { $nin: ['archived'] },
            },
        }

        expect(jsonCollection.aggregateCalls[0][1]).toEqual(expectedMatch)
        expect(arrayCollection.aggregateCalls[0][1]).toEqual(expectedMatch)
    })

    test('builds document aggregation and converts key id to _id', async () => {
        const id = '507f1f77bcf86cd799439011'
        const collection = createMockCollection('products', [{ id, name: 'phone' }])

        const response = await MongoQuery.query(
            baseRequest({
                is_collection: false,
                keys: { id },
            }),
            collection as any
        )

        expect(response.items).toEqual([{ id, name: 'phone' }])
        // The document $match must convert the `id` key to `_id` WITHOUT leaving a stray
        // `id: undefined` key behind (BSON would serialize it to null and break the lookup —
        // see BUG.md). Assert the exact key set, not just a lenient toEqual.
        const match = collection.aggregateCalls[0][0].$match
        expect(Object.keys(match)).toEqual(['_id'])
        expect(match._id).toEqual(ObjectId.createFromHexString(id))
    })

    test(':or builds an $or of its nested conditions (not gated on :and)', async () => {
        const collection = createMockCollection('products', collectionReadResponse())

        await MongoQuery.query(
            baseRequest({
                query: {
                    ':or': { status: 'active', 'role:eq': 'admin' },
                },
            }),
            collection as any
        )

        expect(collection.aggregateCalls[0][1]).toEqual({
            $match: {
                $or: [
                    { status: { $eq: 'active' } },
                    { role: { $eq: 'admin' } },
                ],
            },
        })
    })

    test(':not builds a $nor of its nested conditions', async () => {
        const collection = createMockCollection('products', collectionReadResponse())

        await MongoQuery.query(
            baseRequest({
                query: {
                    ':not': { status: 'archived' },
                },
            }),
            collection as any
        )

        expect(collection.aggregateCalls[0][1]).toEqual({
            $match: {
                $nor: [
                    { status: { $eq: 'archived' } },
                ],
            },
        })
    })

    test(':and ANDs its nested conditions', async () => {
        const collection = createMockCollection('products', collectionReadResponse())

        await MongoQuery.query(
            baseRequest({
                query: {
                    ':and': { 'price:gte': '10', status: 'active' },
                },
            }),
            collection as any
        )

        expect(collection.aggregateCalls[0][1]).toEqual({
            $match: {
                price: { $gte: 10 },
                status: { $eq: 'active' },
            },
        })
    })

    test('combines a top-level field with an :or group via $and', async () => {
        const collection = createMockCollection('products', collectionReadResponse())

        await MongoQuery.query(
            baseRequest({
                query: {
                    status: 'active',
                    ':or': { 'role:eq': 'admin', 'level:gte': '5' },
                },
            }),
            collection as any
        )

        expect(collection.aggregateCalls[0][1]).toEqual({
            $match: {
                $and: [
                    { status: { $eq: 'active' } },
                    { $or: [{ role: { $eq: 'admin' } }, { level: { $gte: 5 } }] },
                ],
            },
        })
    })

    test(':like escapes regex metacharacters and matches case-insensitively', async () => {
        const collection = createMockCollection('products', collectionReadResponse())

        await MongoQuery.query(
            baseRequest({ query: { 'name:like': 'a.b+c' } }),
            collection as any
        )

        expect(collection.aggregateCalls[0][1]).toEqual({
            $match: { $or: [{ name: { $regex: 'a\\.b\\+c', $options: 'i' } }] },
        })
    })

    test(':or keeps OR semantics when a group mixes :like with a plain field', async () => {
        const collection = createMockCollection('products', collectionReadResponse())

        await MongoQuery.query(
            baseRequest({
                query: {
                    ':or': { status: 'active', 'name:like': 'foo' },
                },
            }),
            collection as any
        )

        // Previously this collapsed to a single-element $or wrapping an $and, silently
        // turning OR into AND. It must stay a real two-branch $or.
        expect(collection.aggregateCalls[0][1]).toEqual({
            $match: {
                $or: [
                    { status: { $eq: 'active' } },
                    { name: { $regex: 'foo', $options: 'i' } },
                ],
            },
        })
    })

    test(':or keeps OR semantics for two operators on the same field', async () => {
        const collection = createMockCollection('products', collectionReadResponse())

        await MongoQuery.query(
            baseRequest({
                query: {
                    ':or': { 'price:lt': '10', 'price:gt': '100' },
                },
            }),
            collection as any
        )

        // Same field, different ops: must be two OR branches, not a merged AND on `price`.
        expect(collection.aggregateCalls[0][1]).toEqual({
            $match: {
                $or: [
                    { price: { $lt: 10 } },
                    { price: { $gt: 100 } },
                ],
            },
        })
    })

    test(':not nors each condition separately when a group mixes types', async () => {
        const collection = createMockCollection('products', collectionReadResponse())

        await MongoQuery.query(
            baseRequest({
                query: {
                    ':not': { status: 'archived', 'name:like': 'spam' },
                },
            }),
            collection as any
        )

        expect(collection.aggregateCalls[0][1]).toEqual({
            $match: {
                $nor: [
                    { status: { $eq: 'archived' } },
                    { name: { $regex: 'spam', $options: 'i' } },
                ],
            },
        })
    })

    test(':or with a nested :and group emits the AND as a single branch', async () => {
        const collection = createMockCollection('products', collectionReadResponse())

        await MongoQuery.query(
            baseRequest({
                query: {
                    ':or': { status: 'active', ':and': { 'level:gte': '5', role: 'admin' } },
                },
            }),
            collection as any
        )

        expect(collection.aggregateCalls[0][1]).toEqual({
            $match: {
                $or: [
                    { status: { $eq: 'active' } },
                    { level: { $gte: 5 }, role: { $eq: 'admin' } },
                ],
            },
        })
    })

    test('summary with only a group field (no aggregate fn) does not throw', async () => {
        const collection = createMockCollection('orders', collectionReadResponse())

        // `fns` is empty here; the old code did `fns[0].key` and threw a 500.
        const run = MongoQuery.query(
            baseRequest({ query: { '::byStatus': 'status' } }),
            collection as any
        )

        await expect(run).resolves.toBeDefined()
        const facet = collection.aggregateCalls[0].find((s: any) => s.$facet).$facet
        expect(facet['::byStatus']).toBeArray()
    })

    test('summary with only a $match filter (no aggregate fn) does not throw', async () => {
        const collection = createMockCollection('orders', collectionReadResponse())

        const run = MongoQuery.query(
            baseRequest({ query: { '::active': 'status==active' } }),
            collection as any
        )

        await expect(run).resolves.toBeDefined()
    })

    test('offset paging (:page) skips and limits and is not treated as cursor paging', async () => {
        const collection = createMockCollection('products', [{
            items: [{ id: '1' }],
            has: { prev: true, next: false },
            count: { prev: 10, next: 0 },
            summary: {},
        }])

        await MongoQuery.query(
            baseRequest({ query: { ':page': '2', ':limit': '10' } }),
            collection as any
        )

        const facetStage = collection.aggregateCalls[0].find((s: any) => s.$facet)
        expect(facetStage.$facet.items).toEqual([{ $skip: 10 }, { $limit: 10 }])
        expect(facetStage.$facet.total).toEqual([{ $count: 'count' }])
    })

    test('adds summary facets for options beginning with ::', async () => {
        const collection = createMockCollection('orders', collectionReadResponse())

        await MongoQuery.query(
            baseRequest({
                query: {
                    '::totals': 'category|sum(price)|avg(price)|count()',
                },
            }),
            collection as any
        )

        const facet = collection.aggregateCalls[0].find(stage => stage.$facet).$facet
        expect(facet['::totals']).toBeArray()
        expect(facet['::totals'][0].$group).toEqual({
            _id: { category: '$category' },
            sum_price: { $sum: '$price' },
            avg_price: { $avg: '$price' },
            count: { $sum: 1 },
        })
    })
})
