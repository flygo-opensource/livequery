import { describe, expect, test } from 'bun:test'
import { Cursor } from '../src/Cursor.js'
import { SmartCache } from '../src/SmartCache.js'

describe('Cursor', () => {
    test('caculate encodes id and active sort fields', () => {
        const cursor = Cursor.caculate(
            { id: '507f1f77bcf86cd799439011', price: 42, name: 'phone' },
            { 'price:sort': 'asc', ignored: true }
        )

        expect(cursor).toBeString()
        expect(Cursor.parse(cursor!)).toEqual({
            id: '507f1f77bcf86cd799439011',
            price: 42,
        })
    })

    test('caculate returns null when item is missing', () => {
        expect(Cursor.caculate(undefined as any, {})).toBeNull()
    })

    test('parse returns null for empty cursor', () => {
        expect(Cursor.parse('')).toBeNull()
    })
})

describe('SmartCache', () => {
    test('resolves a key once and reuses the cached promise result', async () => {
        const cache = new SmartCache()
        let calls = 0

        const first = await cache.get('collection', async () => {
            calls += 1
            return { name: 'products' }
        })

        const second = await cache.get('collection', async () => {
            calls += 1
            return { name: 'other' }
        })

        expect(calls).toBe(1)
        expect(second).toBe(first)
    })
})
