import { describe, expect, test } from 'bun:test'
import { ObjectId } from 'mongodb'
import { MongoDatasource } from '../src/MongoDatasource.js'
import { collectionReadResponse, createMockCollection, createMockDb } from './helpers.js'

const id = '507f1f77bcf86cd799439011'
const request = (overrides: Record<string, any>) => ({
    ref: 'messages',
    collection_ref: 'messages',
    schema_collection_ref: 'messages',
    is_collection: true,
    keys: {},
    query: {},
    method: 'get',
    ...overrides,
})

function setup() {
    const messages = createMockCollection('messages', collectionReadResponse([]))
    const datasource = new MongoDatasource({ connections: { default: createMockDb({ messages }) as any } })
    return { messages, datasource }
}

const matchOf = (pipeline: any[]) => JSON.stringify(pipeline.filter(stage => stage.$match))

describe('MongoDatasource sync routes', () => {
    test('writes stamp updated_at', async () => {
        const { messages, datasource } = setup()
        const before = Date.now()
        const added = await datasource.query(request({ method: 'post', body: { text: 'hi' } }) as any, { collection: 'messages', sync: true }) as any
        expect(messages.insertOneCalls[0].updated_at).toBeGreaterThanOrEqual(before)
        expect(added.item.updated_at).toBe(messages.insertOneCalls[0].updated_at)

        const updated = await datasource.query(request({ method: 'patch', is_collection: false, document_id: id, keys: { id }, body: { text: 'hey' } }) as any, { collection: 'messages', sync: true }) as any
        expect(messages.updateOneCalls[0].filter).toEqual({ _id: ObjectId.createFromHexString(id), deleted_at: null })
        expect(messages.updateOneCalls[0].update.$set).toMatchObject({ text: 'hey', updated_at: updated.item.updated_at })
    })

    test('a delete leaves a tombstone', async () => {
        const { messages, datasource } = setup()
        const deleted = await datasource.query(request({ method: 'delete', is_collection: false, document_id: id, keys: { id } }) as any, { collection: 'messages', sync: true }) as any
        expect(messages.deleteOneCalls).toHaveLength(0)
        expect(messages.updateOneCalls[0].update.$set).toEqual({ deleted_at: deleted.item.deleted_at, updated_at: deleted.item.deleted_at })
        expect(deleted.item).toMatchObject({ id, deleted_at: expect.any(Number) })
    })

    test('reads hide tombstones unless a delta asks for them', async () => {
        const { messages, datasource } = setup()
        await datasource.query(request({ query: { ':limit': 10 } }) as any, { collection: 'messages', sync: true })
        expect(matchOf(messages.aggregateCalls[0])).toContain('"deleted_at":{"$eq":null}')

        await datasource.query(request({ query: { 'updated_at:gt': 5, 'updated_at:sort': 'asc', ':tombstones': 1 } }) as any, { collection: 'messages', sync: true })
        const delta = matchOf(messages.aggregateCalls[1])
        expect(delta).not.toContain('deleted_at')
        expect(delta).toContain('"updated_at":{"$gt":5}')
    })

    test('without sync nothing changes', async () => {
        const { messages, datasource } = setup()
        await datasource.query(request({ method: 'delete', is_collection: false, document_id: id, keys: { id } }) as any, { collection: 'messages' })
        expect(messages.deleteOneCalls).toHaveLength(1)
        await datasource.query(request({ query: {} }) as any, { collection: 'messages' })
        expect(matchOf(messages.aggregateCalls[0])).not.toContain('deleted_at')
    })
})
