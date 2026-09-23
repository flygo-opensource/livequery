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
    test('writes take updated_at from the database clock', async () => {
        const { messages, datasource } = setup()
        const added = await datasource.query(request({ method: 'post', body: { text: 'hi', price: '$100' } }) as any, { collection: 'messages', sync: true }) as any
        const insert = messages.findOneAndUpdateCalls[0]!
        // An upsert no existing document can match: a taken _id still fails as a duplicate.
        expect(Object.keys(insert.filter)).toEqual(['_id', '__livequery_inserting'])
        expect(insert.options).toMatchObject({ upsert: true, returnDocument: 'after' })
        expect(insert.update[0].$set).toMatchObject({ text: { $literal: 'hi' }, price: { $literal: '$100' }, updated_at: { $toLong: '$$NOW' } })
        expect(insert.update[1]).toEqual({ $unset: '__livequery_inserting' })
        expect(messages.insertOneCalls).toHaveLength(0)
        expect(added.item).toMatchObject({ text: 'hi', price: '$100', updated_at: messages.dbNow, id: expect.any(String) })

        messages.dbNow++
        const updated = await datasource.query(request({ method: 'patch', is_collection: false, document_id: id, keys: { id }, body: { text: 'hey' } }) as any, { collection: 'messages', sync: true }) as any
        const patch = messages.findOneAndUpdateCalls[1]!
        expect(patch.filter).toEqual({ _id: ObjectId.createFromHexString(id), deleted_at: null })
        expect(patch.update[0].$set).toEqual({ text: { $literal: 'hey' }, updated_at: { $toLong: '$$NOW' } })
        expect(updated.item).toMatchObject({ id, text: 'hey', updated_at: messages.dbNow })
    })

    test('an operator body is stamped by the server instead', async () => {
        const { messages, datasource } = setup()
        const before = Date.now()
        const updated = await datasource.query(request({ method: 'patch', is_collection: false, document_id: id, keys: { id }, body: { $inc: { likes: 1 } } }) as any, { collection: 'messages', sync: true }) as any
        expect(messages.updateOneCalls[0]!.update).toMatchObject({ $inc: { likes: 1 }, $set: { updated_at: expect.any(Number) } })
        expect(updated.item.updated_at).toBeGreaterThanOrEqual(before)
    })

    test('a delete leaves a tombstone', async () => {
        const { messages, datasource } = setup()
        const deleted = await datasource.query(request({ method: 'delete', is_collection: false, document_id: id, keys: { id } }) as any, { collection: 'messages', sync: true }) as any
        expect(messages.deleteOneCalls).toHaveLength(0)
        expect(messages.findOneAndUpdateCalls[0]!.update[0].$set).toEqual({ deleted_at: { $toLong: '$$NOW' }, updated_at: { $toLong: '$$NOW' } })
        expect(deleted.item).toMatchObject({ id, deleted_at: messages.dbNow, updated_at: messages.dbNow })
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
