import { describe, test, expect } from 'bun:test'
import { Observable } from 'rxjs'
import { LivequeryClient } from '../src/LivequeryClient.js'
import { LivequeryCollection } from '../src/LivequeryCollection.js'
import { LivequeryMemoryStorage } from '../src/LivequeryMemoryStorage.js'
import type { Doc, LivequeryTransporter } from '../src/index.js'

// initialize() guards on window — expose it for tests
// @ts-ignore
global.window ??= {}

type Todo = Doc<{ title: string }>

const tick = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms))

// Transporter whose query() is a LONG-LIVED stream (never completes) — simulates a
// WebSocket realtime subscription (socket.listen). Tracks how many query subscriptions
// are live per ref so a leak is observable.
function makeRealtimeTransporter(activeByRef: Map<string, number>): LivequeryTransporter {
    return {
        query: (e: any) => new Observable(subscriber => {
            const ref = e.ref
            activeByRef.set(ref, (activeByRef.get(ref) ?? 0) + 1)
            subscriber.next({ changes: [], paging: { total: 0, current: 0 }, source: 'query' })
            // never complete: a realtime stream stays open until unsubscribed
            return () => activeByRef.set(ref, (activeByRef.get(ref) ?? 1) - 1)
        }) as any,
        add: async (_ref, doc) => ({ id: 'x', ...doc }) as any,
        update: async (_ref, id, patch) => ({ id, ...patch }) as any,
        delete: async (_ref, id) => ({ id } as any),
        trigger: async () => ({} as any),
    }
}

describe('realtime subscription leak on ref change', () => {
    test('old ref query subscription is torn down when the collection unsubscribes', async () => {
        const activeByRef = new Map<string, number>()
        const client = new LivequeryClient({
            storage: new LivequeryMemoryStorage(),
            transporters: { primary: makeRealtimeTransporter(activeByRef) },
        })

        // mount collection for ref-A (server-first → realtime query subscribes)
        const collection = new LivequeryCollection<Todo>(client, { mode: 'server-first' })
        const linker = collection.initialize('todos-a')
        await tick()

        // the realtime query for todos-a is live
        expect(activeByRef.get('todos-a')).toBe(1)

        // simulate useCollection cleanup on ref change / unmount
        linker?.unsubscribe()
        await tick()

        // the old ref's realtime query MUST be torn down (no leak)
        expect(activeByRef.get('todos-a')).toBe(0)
    })
})
