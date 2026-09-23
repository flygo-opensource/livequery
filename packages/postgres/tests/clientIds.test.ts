import { describe, expect, test } from 'bun:test'
import { PostgresDatasource } from '../src/PostgresDatasource.js'
import { baseRequest, createMockDb } from './helpers.js'

const ID = '01890a5d-ac96-774b-bcce-b302099a8057'

const post = (body: Record<string, unknown>) => baseRequest({ method: 'POST', body }) as any

describe('PostgresDatasource client ids', () => {
    test('a uuidv7 from the client is inserted as the key', async () => {
        const db = createMockDb({ write: { id: ID, name: 'phone' } })
        await new PostgresDatasource({ connections: { default: db } }).query(post({ id: ID, name: 'phone' }), { table: 'products' })
        expect(db.last().text).toMatch(/INSERT INTO "public"."products" \("name", "id"\) VALUES \(\$1, \$2\) RETURNING \*/)
        expect(db.last().values).toEqual(['phone', ID])
    })

    test('the client id lands on a renamed key column', async () => {
        const db = createMockDb({ write: { uuid: ID, name: 'phone' } })
        const response = await new PostgresDatasource({ connections: { default: db } })
            .query(post({ id: ID, name: 'phone' }), { table: 'products', idField: 'uuid' })
        expect(db.last().text).toContain('("name", "uuid")')
        expect(response.item).toEqual({ id: ID, name: 'phone' })
    })

    test('a legacy local: id and clientIds: false both leave the key to the database', async () => {
        for (const [body, options] of [
            [{ id: 'local:abc', name: 'phone' }, {}],
            [{ id: ID, name: 'phone' }, { clientIds: false }],
        ] as const) {
            const db = createMockDb({ write: { id: '1', name: 'phone' } })
            await new PostgresDatasource({ connections: { default: db } }).query(post({ ...body }), { table: 'products', ...options })
            expect(db.last().text).toMatch(/\("name"\) VALUES \(\$1\)/)
        }
    })

    test('any other id is 400 INVALID_ID', async () => {
        const db = createMockDb()
        await expect(new PostgresDatasource({ connections: { default: db } }).query(post({ id: 42, name: 'x' }), { table: 'products' }))
            .rejects.toMatchObject({ status: 400, code: 'INVALID_ID' })
    })

    test('unique_violation on the primary key is 409 ID_ALREADY_EXISTS; elsewhere DUPLICATE_KEY', async () => {
        for (const [constraint, code] of [['products_pkey', 'ID_ALREADY_EXISTS'], ['products_sku_key', 'DUPLICATE_KEY']]) {
            const db = createMockDb()
            db.responder = () => { throw Object.assign(new Error('duplicate key'), { code: '23505', constraint }) }
            await expect(new PostgresDatasource({ connections: { default: db } }).query(post({ id: ID, name: 'x' }), { table: 'products' }))
                .rejects.toMatchObject({ status: 409, code })
        }
    })

    test('a key column that is not a uuid (serial) says to turn client ids off', async () => {
        const db = createMockDb()
        db.responder = () => { throw Object.assign(new Error('invalid input syntax for type integer'), { code: '22P02' }) }
        await expect(new PostgresDatasource({ connections: { default: db } }).query(post({ id: ID, name: 'x' }), { table: 'products' }))
            .rejects.toMatchObject({ status: 400, code: 'INVALID_ID' })
    })
})
