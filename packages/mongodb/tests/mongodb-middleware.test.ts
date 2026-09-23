import { describe, expect, test } from 'bun:test'
import { LIVEQUERY_VARS } from '@livequery/core'
import { mongodb } from '../src/mongodb.js'
import { createMockCollection, createMockDb } from './helpers.js'

const id = '507f1f77bcf86cd799439011'

// The middleware as Hono calls it, without a validator in front: the body is whatever was sent.
async function send(method: string, body: Record<string, any>, sync = false) {
    const items = createMockCollection('items')
    const db = createMockDb({ items })
    const vars = new Map<string, unknown>([[LIVEQUERY_VARS.request, {
        ref: `items/${id}`, collection_ref: 'items', document_id: id, is_collection: false,
        keys: { id }, query: {}, method, body,
    }]])
    const c = {
        res: new Response(),
        req: { method, header: () => undefined },
        get: (key: string) => vars.get(key),
        set: (key: string, value: unknown) => vars.set(key, value),
        json: (payload: unknown, status = 200) => Response.json(payload, { status }),
    }
    const run = mongodb({ connection: db as any, collection: 'items', fields: ['title'], ...sync ? { sync: true } : {} })
    const error = await run(c as any, async () => {}).then(() => null, e => e)
    return { items, error }
}

describe('mongodb() — what a client may send in a body', () => {
    for (const sync of [false, true]) {
        test(`update operators from a client are refused${sync ? ' (sync route)' : ''}`, async () => {
            const { items, error } = await send('PATCH', { $unset: { secret: 1 }, $rename: { owner: 'x' } }, sync)
            expect(error).toMatchObject({ status: 400, code: 'INVALID_BODY' })
            expect(items.updateOneCalls).toHaveLength(0)
        })

        test(`dotted paths are refused — they write into nested fields past the allowlist${sync ? ' (sync route)' : ''}`, async () => {
            const { items, error } = await send('PATCH', { 'owner.id': 'me' }, sync)
            expect(error).toMatchObject({ status: 400, code: 'INVALID_BODY' })
            expect(items.updateOneCalls).toHaveLength(0)
        })
    }

    test('a plain body still goes through', async () => {
        const { items, error } = await send('PATCH', { title: 'ok' })
        expect(error).toBeNull()
        expect(items.updateOneCalls[0]!.update).toEqual({ $set: { title: 'ok' } })
    })

    test('an add with an operator key is refused too', async () => {
        const { items, error } = await send('POST', { title: 'x', $where: 'sleep(1000)' })
        expect(error).toMatchObject({ status: 400, code: 'INVALID_BODY' })
        expect(items.insertOneCalls).toHaveLength(0)
    })
})
