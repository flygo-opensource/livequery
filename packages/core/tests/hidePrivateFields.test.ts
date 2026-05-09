import { describe, it, expect } from 'bun:test'
import { hidePrivateFields } from '../src/helpers/hidePrivateFields.js'

describe('hidePrivateFields', () => {
    it('strips underscore-prefixed fields', () => {
        const result = hidePrivateFields({
            id: '1',
            name: 'Alice',
            _updating: true,
            _prev: { name: 'old' }
        })
        expect(result).toEqual({ id: '1', name: 'Alice' })
    })

    it('maps _id to id when id is missing', () => {
        const result = hidePrivateFields({
            id: undefined as any,
            _id: 'mongo-id',
            name: 'Bob'
        })
        expect(result.id).toBe('mongo-id')
    })

    it('prefers id over _id', () => {
        const result = hidePrivateFields({
            id: 'real-id',
            _id: 'mongo-id',
            name: 'Carol'
        })
        expect(result.id).toBe('real-id')
    })

    it('returns empty object when all fields are private', () => {
        const result = hidePrivateFields({ id: '1', _foo: 'bar', _baz: 'qux' })
        expect(result).toEqual({ id: '1' })
    })

    it('handles entities with no private fields', () => {
        const result = hidePrivateFields({ id: '1', title: 'Hello', done: false })
        expect(result).toEqual({ id: '1', title: 'Hello', done: false })
    })
})
