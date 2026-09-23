import { describe, expect, test } from 'bun:test'
import { CLIENT_ID_MAX_FUTURE_MS, resolveClientId } from '../src/helpers/resolveClientId.js'

// uuidv7 with a chosen millisecond timestamp.
const v7 = (ms: number) => {
    const hex = ms.toString(16).padStart(12, '0')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7abc-8def-0123456789ab`
}

describe('resolveClientId', () => {
    const now = Date.UTC(2026, 8, 23)

    test('no id, null id or a non-object body — the datasource assigns the id', () => {
        expect(resolveClientId({ title: 'x' }, now)).toBeUndefined()
        expect(resolveClientId({ id: null }, now)).toBeUndefined()
        expect(resolveClientId(undefined, now)).toBeUndefined()
    })

    test('legacy local: ids from pre-3.0 clients are ignored, not rejected', () => {
        expect(resolveClientId({ id: 'local:01890a5d-ac96-774b-bcce-b302099a8057' }, now)).toBeUndefined()
    })

    test('a uuidv7 is accepted and lower-cased', () => {
        const id = v7(now - 1000)
        expect(resolveClientId({ id }, now)).toBe(id)
        expect(resolveClientId({ id: id.toUpperCase() }, now)).toBe(id)
    })

    test('a timestamp in the past is fine — offline writes arrive days later', () => {
        const id = v7(now - 30 * 24 * 3600 * 1000)
        expect(resolveClientId({ id }, now)).toBe(id)
    })

    test('a timestamp further ahead than the allowed skew is rejected', () => {
        expect(resolveClientId({ id: v7(now + CLIENT_ID_MAX_FUTURE_MS - 1) }, now)).toBeString()
        expect(() => resolveClientId({ id: v7(now + CLIENT_ID_MAX_FUTURE_MS + 1) }, now)).toThrow()
        try {
            resolveClientId({ id: v7(now + 2 * CLIENT_ID_MAX_FUTURE_MS) }, now)
        } catch (e: any) {
            expect(e).toMatchObject({ status: 400, code: 'INVALID_ID' })
        }
    })

    test.each([
        ['an ObjectId', '66f1c2d3e4f5a6b7c8d9e0f1'],
        ['a uuidv4', '9b2f6c1e-3a4d-4f5e-8a6b-7c8d9e0f1a2b'],
        ['a number', 42],
        ['an arbitrary string', 'hello'],
        ['a uuidv7 with a bad variant', '01890a5d-ac96-774b-7cce-b302099a8057'],
    ])('%s is rejected with 400 INVALID_ID', (_label, id) => {
        expect(() => resolveClientId({ id }, now)).toThrow()
        try {
            resolveClientId({ id }, now)
        } catch (e: any) {
            expect(e).toMatchObject({ status: 400, code: 'INVALID_ID' })
        }
    })
})
