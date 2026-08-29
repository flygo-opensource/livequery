/**
 * E2E: how the stack responds to malformed / edge-case requests (#4).
 *
 * Runs against a real Hono + MongoDatasource backend. Malformed input is validated
 * and returns 4xx with a structured error code (never a 500).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { buildHonoMongoApp, type AppHandle } from './helpers/servers.js'
import { uniqueCollection } from './helpers/mongo.js'
import { fetchJson } from './helpers/ws.js'

const COLLECTION = uniqueCollection('malformed')

describe('Malformed / edge-case requests e2e', () => {
    let app: AppHandle

    beforeAll(async () => {
        app = await buildHonoMongoApp({ collection: COLLECTION, ref: 'tasks', realtime: false, wrapData: false })
        await app.collection.insertMany([
            { title: 'a', seq: 1 }, { title: 'b', seq: 2 }, { title: 'c', seq: 3 },
        ])
    }, 30000)

    afterAll(async () => { await app?.close() }, 30000)

    // ── Gracefully-handled cases ────────────────────────────────────────────────

    test('huge :limit is clamped, returns 200', async () => {
        const { status, body } = await fetchJson(`${app.apiUrl}/tasks?:limit=999999999`)
        expect(status).toBe(200)
        expect(Array.isArray(body.items)).toBe(true)
    })

    test('invalid eq-oid filter value is ignored gracefully (200, empty match)', async () => {
        const { status, body } = await fetchJson(`${app.apiUrl}/tasks?ownerId:eq-oid=not-a-valid-oid`)
        expect(status).toBe(200)
        expect(body.count.current).toBe(0)
    })

    test('empty filter value → 200', async () => {
        const { status } = await fetchJson(`${app.apiUrl}/tasks?title:eq=`)
        expect(status).toBe(200)
    })

    test('document that does not exist → 200 with no item (not a 404)', async () => {
        const { status, body } = await fetchJson(`${app.apiUrl}/tasks/000000000000000000000000`)
        expect(status).toBe(200)
        expect(body.item).toBeUndefined()
    })

    test('unknown route → 404', async () => {
        const { status } = await fetchJson(`${app.apiUrl}/nope`)
        expect(status).toBe(404)
    })

    test('non-livequery path is rejected by the parser', async () => {
        // parser requires the `livequery` prefix; a bare path should not 200 as a query
        const res = await fetch(`http://127.0.0.1:${app.port}/not-livequery/tasks`)
        expect(res.status).toBeGreaterThanOrEqual(400)
    })

    // ── Input validation: malformed values return 400, not 500 ──────────────────

    test('malformed :after cursor returns 400 INVALID_CURSOR', async () => {
        const { status, body } = await fetchJson(`${app.apiUrl}/tasks?:after=garbage`)
        expect(status).toBe(400)
        expect(body.error.code).toBe('INVALID_CURSOR')
    })

    test('invalid ObjectId in a document path returns 400 and names the field', async () => {
        const { status, body } = await fetchJson(`${app.apiUrl}/tasks/not-an-objectid`)
        expect(status).toBe(400)
        expect(body.error.code).toBe('INVALID_OBJECT_ID')
        // the error message pinpoints which field is invalid
        expect(body.error.message).toContain('"id"')
        expect(body.error.message).toContain('not-an-objectid')
    })

    test('invalid ObjectId on a write (PATCH by id) also returns 400 naming the field', async () => {
        const { status, body } = await fetchJson(`${app.apiUrl}/tasks/xyz`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'nope' }),
        })
        expect(status).toBe(400)
        expect(body.error.code).toBe('INVALID_OBJECT_ID')
        expect(body.error.message).toContain('"id"')
    })
})
