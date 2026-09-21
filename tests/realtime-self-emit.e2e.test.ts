/**
 * E2E: self-emitted realtime — no MongodbRealtime watcher involved.
 *
 * Services push updates themselves via `gateway.next(UpdatedData)` (e.g. after a
 * write) or register a live pipe with `gateway.link(ref, ...)`. Raw WS clients
 * subscribe through GET + x-lcid headers and must receive sync events.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { interval, map } from 'rxjs'
import { buildNestMongoApp, type AppHandle } from './helpers/servers.js'
import { uniqueCollection } from './helpers/mongo.js'
import { sleep } from './helpers/wait.js'
import { fetchJson, sendJson, waitForWsMessage, wsStart } from './helpers/ws.js'

const COLLECTION = uniqueCollection('self_emit')

describe('Self-emitted realtime e2e (gateway.next / gateway.link)', () => {
    let app: AppHandle

    beforeAll(async () => {
        // realtime:false — every sync in this suite is emitted by "service code"
        app = await buildNestMongoApp({ collection: COLLECTION, ref: 'tasks', realtime: false })
    }, 30000)

    afterAll(async () => {
        await app?.close()
    }, 30000)

    async function subscribe(clientId: string, ref = 'tasks') {
        const { ws, gatewayId } = await wsStart(app.wsUrl, clientId)
        const res = await fetchJson(`${app.apiUrl}/${ref}`, {
            headers: { 'x-lcid': clientId, 'x-lgid': gatewayId },
        })
        expect(res.status).toBe(200)
        await sleep(100)
        return ws
    }

    test('gateway.next() delivers a manual update to a subscribed client', async () => {
        const ws = await subscribe('emit-basic')
        try {
            const syncP = waitForWsMessage<any>(ws, m =>
                m.event === 'sync' && m.data.changes.some((c: any) => c.data?.id === 'manual-1'))

            app.gateway.next({ ref: 'tasks', type: 'added', data: { id: 'manual-1', title: 'hand-made' } } as any)

            const sync = await syncP
            const change = sync.data.changes.find((c: any) => c.data?.id === 'manual-1')
            expect(change.type).toBe('added')
            expect(change.data.title).toBe('hand-made')
        } finally {
            ws.close()
        }
    })

    test('two subscribers on the same ref both receive the emission', async () => {
        const wsA = await subscribe('emit-a')
        const wsB = await subscribe('emit-b')
        try {
            const pA = waitForWsMessage<any>(wsA, m => m.event === 'sync' && m.data.changes.some((c: any) => c.data?.id === 'fanout-1'))
            const pB = waitForWsMessage<any>(wsB, m => m.event === 'sync' && m.data.changes.some((c: any) => c.data?.id === 'fanout-1'))

            app.gateway.next({ ref: 'tasks', type: 'modified', data: { id: 'fanout-1', done: true } } as any)

            const [a, b] = await Promise.all([pA, pB])
            expect(a.data.changes[0].data.done).toBe(true)
            expect(b.data.changes[0].data.done).toBe(true)
        } finally {
            wsA.close()
            wsB.close()
        }
    })

    test('document-level subscription receives doc-ref emissions, other docs do not leak', async () => {
        // insert real docs so the document GET succeeds
        const d1 = await app.collection.insertOne({ title: 'doc-1' })
        const d2 = await app.collection.insertOne({ title: 'doc-2' })
        const id1 = d1.insertedId.toString()
        const id2 = d2.insertedId.toString()

        const ws1 = await subscribe('emit-doc1', `tasks/${id1}`)
        const ws2 = await subscribe('emit-doc2', `tasks/${id2}`)
        try {
            let ws2got = false
            ws2.addEventListener('message', (e: MessageEvent) => {
                try { if (JSON.parse(e.data).event === 'sync') ws2got = true } catch { /* noop */ }
            })

            const p1 = waitForWsMessage<any>(ws1, m => m.event === 'sync' && m.data.changes.some((c: any) => c.data?.id === id1))
            app.gateway.next({ ref: `tasks/${id1}`, type: 'modified', data: { id: id1, title: 'doc-1-updated' } } as any)

            const sync = await p1
            expect(sync.data.changes[0].data.title).toBe('doc-1-updated')

            await sleep(400)
            expect(ws2got).toBe(false)
        } finally {
            ws1.close()
            ws2.close()
        }
    })

    test('gateway.link() registers a live pipe that streams to subscribers', async () => {
        const ws = await subscribe('emit-link')
        try {
            await app.gateway.link('tasks', () => interval(150).pipe(
                map(n => ({ ref: 'tasks', type: 'added' as const, data: { id: `tick-${n}`, n } })),
            ) as any)

            const first = await waitForWsMessage<any>(ws, m =>
                m.event === 'sync' && m.data.changes.some((c: any) => String(c.data?.id).startsWith('tick-')))
            const firstId = first.data.changes[0].data.id

            const second = await waitForWsMessage<any>(ws, m =>
                m.event === 'sync' && m.data.changes.some((c: any) =>
                    String(c.data?.id).startsWith('tick-') && c.data.id !== firstId))
            expect(second.data.changes[0].data.id).not.toBe(firstId)
        } finally {
            // replace the pipe with nothing to stop the interval
            await app.gateway.link('tasks', () => undefined as any)
            ws.close()
        }
    })

    test('unsubscribe stops delivery; the other subscriber keeps receiving', async () => {
        const stayId = 'emit-stay'
        const leaveId = 'emit-leave'
        const wsStay = await subscribe(stayId)
        const wsLeave = await subscribe(leaveId)
        try {
            // both receive the first emission
            const p1 = waitForWsMessage<any>(wsStay, m => m.event === 'sync' && m.data.changes.some((c: any) => c.data?.id === 'unsub-1'))
            const p2 = waitForWsMessage<any>(wsLeave, m => m.event === 'sync' && m.data.changes.some((c: any) => c.data?.id === 'unsub-1'))
            app.gateway.next({ ref: 'tasks', type: 'added', data: { id: 'unsub-1' } } as any)
            await Promise.all([p1, p2])

            sendJson(wsLeave, { event: 'unsubscribe', data: { ref: 'tasks', client_id: leaveId } })
            await sleep(150)

            let leaveGot = false
            wsLeave.addEventListener('message', (e: MessageEvent) => {
                try { if (JSON.parse(e.data).event === 'sync') leaveGot = true } catch { /* noop */ }
            })
            const pStay = waitForWsMessage<any>(wsStay, m => m.event === 'sync' && m.data.changes.some((c: any) => c.data?.id === 'unsub-2'))
            app.gateway.next({ ref: 'tasks', type: 'added', data: { id: 'unsub-2' } } as any)

            await pStay
            await sleep(400)
            expect(leaveGot).toBe(false)
        } finally {
            wsStay.close()
            wsLeave.close()
        }
    })
})
