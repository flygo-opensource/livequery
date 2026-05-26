import { describe, expect, test } from 'bun:test'
import { ObjectId } from 'bson'
import { MongoQuery } from '../src/MongoQuery.js'
import { baseRequest, collectionReadResponse, createMockCollection } from './helpers.js'

describe('MongoQuery.query', () => {
    test('builds collection aggregation with sort, filters, search, id rename, and cursor paging', async () => {
        const collection = createMockCollection('products', collectionReadResponse())
        const ownerId = '507f1f77bcf86cd799439011'

        const response = await MongoQuery.query(
            baseRequest({
                options: {
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

    test('clamps limit to the supported range', async () => {
        const collection = createMockCollection('products', collectionReadResponse())

        expect((await MongoQuery.query(baseRequest({ options: { ':limit': '0' } }), collection as any)).limit).toBe(1)
        expect((await MongoQuery.query(baseRequest({ options: { ':limit': '101' } }), collection as any)).limit).toBe(100)
        expect((await MongoQuery.query(baseRequest({ options: { ':limit': 'x' } }), collection as any)).limit).toBe(10)
    })

    test('builds in and nin filters from JSON strings or arrays', async () => {
        const jsonCollection = createMockCollection('products', collectionReadResponse())
        const arrayCollection = createMockCollection('products', collectionReadResponse())

        await MongoQuery.query(
            baseRequest({
                options: {
                    'status:in': '["active","pending"]',
                    'category:nin': '["archived"]',
                },
            }),
            jsonCollection as any
        )

        await MongoQuery.query(
            baseRequest({
                options: {
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
        expect(collection.aggregateCalls[0][0]).toEqual({
            $match: {
                id: undefined,
                _id: ObjectId.createFromHexString(id),
            },
        })
    })

    test('adds summary facets for options beginning with ::', async () => {
        const collection = createMockCollection('orders', collectionReadResponse())

        await MongoQuery.query(
            baseRequest({
                options: {
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
