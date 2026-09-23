import { describe, expect, test } from 'bun:test'
import { D1Datasource } from '../src/D1Datasource.js'
import { baseRequest, createMockD1 } from './helpers.js'

const ID = '01890a5d-ac96-774b-bcce-b302099a8057'

const post = (body: Record<string, unknown>) => baseRequest({ method: 'POST', body }) as any

describe('D1Datasource client ids', () => {
    test('a uuidv7 from the client becomes the row id', async () => {
        const db = createMockD1()
        const response = await new D1Datasource({ databases: { default: db } }).query(post({ id: ID, name: 'phone' }), { table: 'products' })
        expect(db.last().sql).toBe('INSERT INTO products (name, id) VALUES (?, ?)')
        expect(db.last().values).toEqual(['phone', ID])
        expect('item' in response && response.item.id).toBe(ID)
    })

    test('a legacy local: id is ignored — the server assigns one', async () => {
        const db = createMockD1()
        await new D1Datasource({ databases: { default: db } }).query(post({ id: 'local:abc', name: 'phone' }), { table: 'products' })
        const id = db.last().values[1]
        expect(id).not.toBe('local:abc')
        expect(typeof id).toBe('string')
    })

    test('any other id is 400 INVALID_ID and nothing is written', async () => {
        const db = createMockD1()
        await expect(new D1Datasource({ databases: { default: db } }).query(post({ id: 'abc', name: 'phone' }), { table: 'products' }))
            .rejects.toMatchObject({ status: 400, code: 'INVALID_ID' })
        expect(db.queries).toHaveLength(0)
    })

    test('clientIds: false ignores the client id', async () => {
        const db = createMockD1()
        await new D1Datasource({ databases: { default: db } }).query(post({ id: ID, name: 'phone' }), { table: 'products', clientIds: false })
        expect(db.last().values[1]).not.toBe(ID)
    })

    test('a duplicate id is 409 ID_ALREADY_EXISTS; another unique index is 409 DUPLICATE_KEY', async () => {
        for (const [message, code] of [
            ['D1_ERROR: UNIQUE constraint failed: products.id: SQLITE_CONSTRAINT', 'ID_ALREADY_EXISTS'],
            ['D1_ERROR: UNIQUE constraint failed: products.sku: SQLITE_CONSTRAINT', 'DUPLICATE_KEY'],
        ]) {
            const db = createMockD1()
            const prepare = db.prepare.bind(db)
            ;(db as any).prepare = (sql: string) => {
                const statement: any = prepare(sql)
                statement.run = async () => { throw new Error(message) }
                return statement
            }
            await expect(new D1Datasource({ databases: { default: db } }).query(post({ id: ID, name: 'phone' }), { table: 'products' }))
                .rejects.toMatchObject({ status: 409, code })
        }
    })
})
