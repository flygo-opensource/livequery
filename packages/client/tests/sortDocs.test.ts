import { describe, expect, test } from 'bun:test'
import { compareDocs, compareStrings, compareValues } from '../src/helpers/sortDocs.js'

describe("local sort order follows MongoDB's", () => {
    test('across types: null < numbers < strings < objects < arrays < booleans', () => {
        const values = [true, [1], { a: 1 }, 'a', 2, null]
        expect([...values].sort(compareValues)).toEqual([null, 2, 'a', { a: 1 }, [1], true])
        // No coercion: the number 10 comes before any string, '10' included.
        expect(['10', 9, '9', 10].sort(compareValues)).toEqual([9, 10, '10', '9'])
    })

    test('strings by code point: an emoji comes after U+FF01, unlike UTF-16 order', () => {
        expect('\u{1F600}' < '！').toBe(true)  // JS compares UTF-16 units
        expect(compareStrings('\u{1F600}', '！')).toBe(1)
        expect(compareStrings('B', 'b')).toBe(-1)
        expect(compareStrings('', 'a')).toBe(-1)
    })

    test('ids: UUIDs before ObjectIds, then plain strings in between as MongoDB types them', () => {
        const docs = [
            { id: '65a000000000000000000001' },
            { id: '0192aaaa-0000-7000-8000-000000000000' },
            { id: 'plain' },
        ]
        const asc = [...docs].sort(compareDocs([['n', 'asc']]))
        expect(asc.map(d => d.id)).toEqual(['plain', '0192aaaa-0000-7000-8000-000000000000', '65a000000000000000000001'])
    })

    test('an array field: smallest element ascending, largest descending; empty before null', () => {
        const docs = [{ id: '1', v: [5, 1] }, { id: '2', v: [3] }, { id: '3', v: [] }, { id: '4', v: null }]
        expect([...docs].sort(compareDocs([['v', 'asc']])).map(d => d.id)).toEqual(['3', '4', '1', '2'])
        expect([...docs].sort(compareDocs([['v', 'desc']])).map(d => d.id)).toEqual(['1', '2', '4', '3'])
    })
})
