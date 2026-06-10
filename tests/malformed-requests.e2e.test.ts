/**
 * E2E: how the stack responds to malformed / edge-case requests (#4).
 *
 * Documents the CURRENT behaviour against a real Hono + MongoDatasource backend.
 * Two cases are flagged 🐞 as bugs (user input → HTTP 500); the assertions pin the
 * present behaviour so a fix to 4xx is a deliberate, visible change.
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

    // ── 🐞 Bugs: user input causes HTTP 500 (should be 400/404) ──────────────────

    test('🐞 malformed :after cursor currently returns 500 (should be 400)', async () => {
        const { status, body } = await fetchJson(`${app.apiUrl}/tasks?:after=garbage`)
        // BUG: Cursor.parse JSON.parses hex-decoded junk and throws → 500.
        // Pinned here; flip to 400 + a CURSOR_INVALID code when fixed.
        expect(status).toBe(500)
        expect(body?.error ?? body).toBeDefined()
    })

    test('🐞 invalid ObjectId in a document path currently returns 500 (should be 404/400)', async () => {
        const { status } = await fetchJson(`${app.apiUrl}/tasks/not-an-objectid`)
        // BUG: ObjectId.createFromHexString throws on invalid hex → 500.
        expect(status).toBe(500)
    })
})
