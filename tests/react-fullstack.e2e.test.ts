/**
 * E2E: React hooks (@livequery/react) on top of the real stack:
 *   useCollection/useDocument/useObservable/useAction
 *     → LivequeryClient + RestTransporter → NestJS → MongoDatasource → real MongoDB
 *     → realtime via change streams updating hook state.
 *
 * No DOM: react-test-renderer with act(), the same harness the react package uses.
 */

// LivequeryCollection.initialize() bails out under SSR; bun has no window.
;(globalThis as any).window ??= {}
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import React, { act } from '../react/node_modules/react/index.js'
import { create, type ReactTestRenderer } from '../react/node_modules/react-test-renderer/index.js'
import { LivequeryClientProvider } from '../react/src/LivequeryClientContext.js'
import { useCollection } from '../react/src/useCollection.js'
import { useDocument } from '../react/src/useDocument.js'
import { useObservable } from '../react/src/useObservable.js'
import { useAction } from '../react/src/useAction.js'
// Import the client from the same module instance the react hooks resolve
// ('@livequery/client' → react/node_modules symlink → client/dist).
import { LivequeryClient, LivequeryMemoryStorage } from '../react/node_modules/@livequery/client/dist/index.js'
import { RestTransporter } from '../rest/src/RestTransporter.js'
import { buildNestMongoApp, type AppHandle } from './helpers/servers.js'
import { uniqueCollection } from './helpers/mongo.js'
import { warmupRealtime } from './helpers/realtime.js'
import { sleep } from './helpers/wait.js'

const COLLECTION = uniqueCollection('react_full')

type Task = { id: string, title: string, done: boolean, seq: number }

describe('React hooks → NestJS → MongoDatasource fullstack e2e', () => {
    let app: AppHandle
    let transporter: RestTransporter
    let client: InstanceType<typeof LivequeryClient>
    const renderers: ReactTestRenderer[] = []

    /** Render a hook inside the LivequeryClientProvider; returns a live state getter. */
    function renderHook<T>(hook: () => T) {
        const state = { current: undefined as T | undefined }
        const Probe = () => {
            state.current = hook()
            return null
        }
        let renderer!: ReactTestRenderer
        act(() => {
            renderer = create(React.createElement(
                LivequeryClientProvider as any,
                { core: client },
                React.createElement(Probe),
            ))
        })
        renderers.push(renderer)
        return state
    }

    /** Flush react updates until `check` returns truthy. */
    async function waitForHook<T>(check: () => T | undefined | null | false, timeout = 15000, label = 'hook state') {
        const started = Date.now()
        while (Date.now() - started < timeout) {
            await act(async () => { await sleep(50) })
            const value = check()
            if (value) return value
        }
        throw new Error(`Timed out waiting for ${label}`)
    }

    beforeAll(async () => {
        app = await buildNestMongoApp({ collection: COLLECTION, ref: 'tasks', realtime: true })
        await warmupRealtime(app, 'tasks')
        await app.collection.insertMany([
            { title: 'react-seed-1', done: false, seq: 1 },
            { title: 'react-seed-2', done: true, seq: 2 },
        ])

        transporter = new RestTransporter({ api: app.apiUrl, ws: app.wsUrl })
        client = new LivequeryClient({
            storage: new LivequeryMemoryStorage(),
            transporters: { rest: transporter },
        })
    }, 60000)

    afterAll(async () => {
        for (const renderer of renderers) {
            act(() => renderer.unmount())
        }
        client?.destroy?.()
        ;(transporter as any)?.socket?.stop?.()
        await app?.close()
    }, 30000)

    test('useCollection loads items from the real backend', async () => {
        const state = renderHook(() => {
            const collection = useCollection<Task>('tasks')
            const items = useObservable(collection.items)
            const loading = useObservable(collection.loading)
            return { collection, items, loading }
        })

        await waitForHook(() => (state.current?.items?.length ?? 0) >= 2, 15000, 'collection items')
        const titles = state.current!.items!.map((d: any) => d.value.title)
        expect(titles).toEqual(expect.arrayContaining(['react-seed-1', 'react-seed-2']))
        expect(state.current!.loading ?? null).toBeNull()
    })

    test('realtime mongo change updates hook-held documents', async () => {
        const state = renderHook(() => {
            const collection = useCollection<Task>('tasks')
            const items = useObservable(collection.items)
            return { items }
        })
        await waitForHook(() => (state.current?.items?.length ?? 0) >= 2, 15000, 'initial items')

        await app.collection.updateOne({ title: 'react-seed-1' }, { $set: { title: 'react-seed-1-live' } })
        await waitForHook(
            () => state.current!.items!.some((d: any) => d.value.title === 'react-seed-1-live'),
            15000,
            'realtime modified in hook state',
        )

        await app.collection.insertOne({ title: 'react-live-insert', done: false, seq: 3 })
        await waitForHook(
            () => state.current!.items!.some((d: any) => d.value.title === 'react-live-insert'),
            15000,
            'realtime added in hook state',
        )
    })

    test('useDocument follows a single document', async () => {
        const inserted = await app.collection.insertOne({ title: 'react-doc', done: false, seq: 10 })
        const id = inserted.insertedId.toString()

        const state = renderHook(() => {
            const [item, loading, error] = useDocument<Task>(`tasks/${id}`)
            return { item, loading, error }
        })

        await waitForHook(() => state.current?.item?.value?.title === 'react-doc', 15000, 'document loaded')
        expect(state.current!.error ?? null).toBeNull()
    })

    test('useAction wraps a mutation with loading/data state and persists to mongo', async () => {
        const state = renderHook(() => {
            const collection = useCollection<Task>('tasks')
            const addTask = useAction(async (title: string) =>
                await collection.add({ title, done: false, seq: 50 } as any))
            return { collection, addTask }
        })

        await waitForHook(() => state.current?.addTask, 15000, 'action ready')

        let result: any
        await act(async () => {
            result = await state.current!.addTask('react-action-add')
        })
        expect(result.id).toBeString()

        const stored = await app.collection.findOne({ title: 'react-action-add' })
        expect(stored).not.toBeNull()
        expect(stored!._id.toString()).toBe(result.id)
        expect(state.current!.addTask.error).toBeUndefined()
    })
})
