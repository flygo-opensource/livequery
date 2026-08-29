import { describe, expect, test } from 'bun:test'
import { filterDocs, matchesAllFilters } from '../src/helpers/filterDocs.js'

const docs = [
    {
        id: '507f1f77bcf86cd799439011',
        title: 'Livequery MongoDB adapter',
        status: 'active',
        done: false,
        priority: 2,
        price: 25,
        ownerId: '507f191e810c19729de860ea',
        deletedAt: null,
        author: {
            profile: {
                name: 'Ada',
            },
        },
    },
    {
        id: '507f1f77bcf86cd799439012',
        title: 'Client filters',
        status: 'archived',
        done: true,
        priority: 5,
        price: 100,
        ownerId: '507f191e810c19729de860eb',
        deletedAt: 1700000000000,
        author: {
            profile: {
                name: 'Grace',
            },
        },
    },
]

describe('filterDocs', () => {
    test('matches default equality and nested paths', () => {
        expect(filterDocs(docs, { status: 'active' }).map(doc => doc.id)).toEqual([
            '507f1f77bcf86cd799439011',
        ])

        expect(filterDocs(docs, { 'author.profile.name': 'Grace' }).map(doc => doc.id)).toEqual([
            '507f1f77bcf86cd799439012',
        ])
    })

    test('ignores paging and sort keys during filtering', () => {
        expect(filterDocs(docs, {
            ':limit': 1,
            ':after': 'cursor',
            'price:sort': 'desc',
        }).map(doc => doc.id)).toEqual([
            '507f1f77bcf86cd799439011',
            '507f1f77bcf86cd799439012',
        ])
    })

    test('matches numeric comparison operators with MongoDB-style expected coercion', () => {
        expect(filterDocs(docs, { 'price:gt': '30' }).map(doc => doc.id)).toEqual([
            '507f1f77bcf86cd799439012',
        ])

        expect(filterDocs(docs, { 'price:gte': '25' }).map(doc => doc.id)).toEqual([
            '507f1f77bcf86cd799439011',
            '507f1f77bcf86cd799439012',
        ])

        expect(filterDocs(docs, { 'price:lt': '30' }).map(doc => doc.id)).toEqual([
            '507f1f77bcf86cd799439011',
        ])

        expect(filterDocs(docs, { 'price:lte': '25' }).map(doc => doc.id)).toEqual([
            '507f1f77bcf86cd799439011',
        ])
    })

    test('matches eq-number and neq-number', () => {
        expect(filterDocs(docs, { 'priority:eq-number': '2' }).map(doc => doc.id)).toEqual([
            '507f1f77bcf86cd799439011',
        ])

        expect(filterDocs(docs, { 'priority:neq-number': '2' }).map(doc => doc.id)).toEqual([
            '507f1f77bcf86cd799439012',
        ])
    })

    test('matches ne, in, and nin', () => {
        expect(filterDocs(docs, { 'status:ne': 'active' }).map(doc => doc.id)).toEqual([
            '507f1f77bcf86cd799439012',
        ])

        expect(filterDocs(docs, { 'status:in': '["active","pending"]' }).map(doc => doc.id)).toEqual([
            '507f1f77bcf86cd799439011',
        ])

        expect(filterDocs(docs, { 'status:nin': ['archived'] }).map(doc => doc.id)).toEqual([
            '507f1f77bcf86cd799439011',
        ])
    })

    test('matches boolean aliases used by MongoQuery', () => {
        expect(filterDocs(docs, { 'done:eq-boolean': 'false' }).map(doc => doc.id)).toEqual([
            '507f1f77bcf86cd799439011',
        ])

        expect(filterDocs(docs, { 'done:neq-boolean': 'false' }).map(doc => doc.id)).toEqual([
            '507f1f77bcf86cd799439012',
        ])
    })

    test('matches null aliases used by MongoQuery', () => {
        expect(filterDocs(docs, { 'deletedAt:eq-null': true }).map(doc => doc.id)).toEqual([
            '507f1f77bcf86cd799439011',
        ])

        expect(filterDocs(docs, { 'deletedAt:neq-null': true }).map(doc => doc.id)).toEqual([
            '507f1f77bcf86cd799439012',
        ])
    })

    test('matches oid aliases by string value', () => {
        expect(filterDocs(docs, { 'ownerId:eq-oid': '507f191e810c19729de860ea' }).map(doc => doc.id)).toEqual([
            '507f1f77bcf86cd799439011',
        ])

        expect(filterDocs(docs, { 'ownerId:neq-oid': '507f191e810c19729de860ea' }).map(doc => doc.id)).toEqual([
            '507f1f77bcf86cd799439012',
        ])
    })

    test('matches like as a regular expression', () => {
        expect(filterDocs(docs, { 'title:like': '^Livequery' }).map(doc => doc.id)).toEqual([
            '507f1f77bcf86cd799439011',
        ])
    })
})

describe('matchesAllFilters', () => {
    test('requires all filters to match', () => {
        expect(matchesAllFilters(docs[0], {
            status: 'active',
            'price:gte': '20',
            'done:eq-boolean': 'false',
        })).toBe(true)

        expect(matchesAllFilters(docs[0], {
            status: 'active',
            'price:gte': '50',
        })).toBe(false)
    })
})
