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
    const db = createMockDb({ messages })
    const datasource = new MongoDatasource({ connections: { default: db as any } })
    return { messages, datasource, versions: db.versions }
}

const matchOf = (pipeline: any[]) => JSON.stringify(pipeline.filter(stage => stage.$match))

describe('MongoDatasource sync routes', () => {
    test('every write takes the next version of the collection, inside a transaction', async () => {
        const { messages, datasource, versions } = setup()
        const added = await datasource.query(request({ method: 'post', body: { text: 'hi', price: '$100' } }) as any, { collection: 'messages', sync: true }) as any
        expect(messages.insertOneCalls[0]).toMatchObject({ text: 'hi', price: '$100', updated_at: versions.state.last })
        expect(added.item).toMatchObject({ text: 'hi', updated_at: versions.state.last, id: expect.any(String) })

        const updated = await datasource.query(request({ method: 'patch', is_collection: false, document_id: id, keys: { id }, body: { text: 'hey' } }) as any, { collection: 'messages', sync: true }) as any
        expect(messages.updateOneCalls[0]).toEqual({
            filter: { _id: ObjectId.createFromHexString(id), deleted_at: null },
            update: { $set: { text: 'hey', updated_at: versions.state.last } },
        })
        expect(updated.item).toMatchObject({ id, text: 'hey', updated_at: versions.state.last })

        // Operators get a version too.
        await datasource.query(request({ method: 'patch', is_collection: false, document_id: id, keys: { id }, body: { $inc: { likes: 1 } } }) as any, { collection: 'messages', sync: true })
        expect(messages.updateOneCalls[1]!.update).toEqual({ $inc: { likes: 1 }, $set: { updated_at: versions.state.last } })
        expect(versions.state.transactions).toBe(3)
    })

    test('If-Match: the write only matches the version it was based on; another one is a 409', async () => {
        const { messages, datasource } = setup()
        await datasource.query(request({ method: 'patch', is_collection: false, document_id: id, keys: { id }, body: { text: 'a' }, if_version: 7 }) as any, { collection: 'messages', sync: true })
        expect(messages.updateOneCalls[0]!.filter).toMatchObject({ deleted_at: null, updated_at: 7 })

        // Someone else wrote version 8 in between.
        messages.stored = { _id: id, updated_at: 8 }
        const error = await datasource.query(request({ method: 'patch', is_collection: false, document_id: id, keys: { id }, body: { text: 'b' }, if_version: 7 }) as any, { collection: 'messages', sync: true }).then(() => null, e => e)
        expect(error).toMatchObject({ status: 409, code: 'VERSION_CONFLICT' })

        // Without If-Match: no condition, as before.
        messages.stored = null
        await datasource.query(request({ method: 'patch', is_collection: false, document_id: id, keys: { id }, body: { text: 'c' } }) as any, { collection: 'messages', sync: true })
        expect(messages.updateOneCalls.at(-1)!.filter).not.toHaveProperty('updated_at')
    })

    test('a delete leaves a tombstone', async () => {
        const { messages, datasource, versions } = setup()
        const deleted = await datasource.query(request({ method: 'delete', is_collection: false, document_id: id, keys: { id } }) as any, { collection: 'messages', sync: true }) as any
        expect(messages.deleteOneCalls).toHaveLength(0)
        expect(messages.updateOneCalls[0]!.update).toEqual({ $set: { deleted_at: versions.state.last, updated_at: versions.state.last } })
        expect(deleted.item).toMatchObject({ id, deleted_at: versions.state.last, updated_at: versions.state.last })
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
