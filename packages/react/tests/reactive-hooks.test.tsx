/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import React, { act } from "react"
import { BehaviorSubject, Observable, Subject } from "rxjs"
import { create } from "react-test-renderer"
import {
    LivequeryClient,
    LivequeryMemoryStorage,
    type DataChangeEvent,
    type Doc,
    type LivequeryQueryResult,
    type LivequeryTransporter,
} from "@livequery/client"
import { useCollection } from "../src/useCollection.js"
import { useDocument } from "../src/useDocument.js"
import { LivequeryClientProvider } from "../src/LivequeryClientContext.js"

;(globalThis as any).window ??= globalThis
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Todo = Doc & { title: string }

function makeClient() {
    const realtime$ = new Subject<DataChangeEvent>()
    const transporter: LivequeryTransporter = {
        query: () => new Observable<Partial<LivequeryQueryResult>>(subscriber => {
            subscriber.next({
                changes: [{ collection_ref: "todos", id: "1", type: "added", data: { id: "1", title: "one" } }],
                paging: { current: 1, total: 1 },
                source: "query",
            })
            return realtime$.subscribe(change => subscriber.next({ changes: [change], source: "realtime" }))
        }),
        add: async () => ({} as any),
        update: async () => ({} as any),
        delete: async () => ({} as any),
        trigger: async () => ({} as any),
        status$: new BehaviorSubject({ connected: true }),
    }
    const client = new LivequeryClient({ storage: new LivequeryMemoryStorage(), transporters: { t: transporter } })
    return { client, realtime$ }
}

const tick = (ms = 30) => act(async () => { await new Promise((r) => setTimeout(r, ms)) })

describe("reactive hooks — no useObservable needed", () => {
    test("useCollection re-renders on new items and on a document changing in place", async () => {
        const { client, realtime$ } = makeClient()
        let titles: string[] = []
        let renders = 0
        const List = () => {
            const todos = useCollection<Todo>("todos")
            renders++
            titles = todos.items.value.map(d => d.value.title)
            return null
        }
        act(() => { create(<LivequeryClientProvider core={client}><List /></LivequeryClientProvider>) })
        await tick()
        expect(titles).toEqual(["one"])

        act(() => realtime$.next({ collection_ref: "todos", id: "1", type: "modified", data: { title: "one!" } }))
        await tick()
        expect(titles).toEqual(["one!"])

        const before = renders
        act(() => {
            for (let i = 2; i < 12; i++) realtime$.next({ collection_ref: "todos", id: `${i}`, type: "added", data: { id: `${i}`, title: `${i}` } })
        })
        await tick()
        expect(titles.length).toBe(11)
        // A burst of changes renders a handful of times, not once per change.
        expect(renders - before).toBeLessThan(5)
        client.destroy()
    })

    test("useDocument reads livequery/status and switches offline", async () => {
        const { client } = makeClient()
        let status: any
        let setOffline: (offline: boolean) => void = () => {}
        const Status = () => {
            const [doc] = useDocument<any>("livequery/status")
            status = doc?.value
            setOffline = offline => { doc?.update({ offline }) }
            return null
        }
        act(() => { create(<LivequeryClientProvider core={client}><Status /></LivequeryClientProvider>) })
        await tick()
        expect(status).toMatchObject({ connected: true, offline: false })

        await act(async () => setOffline(true))
        await tick()
        expect(status).toMatchObject({ connected: false, offline: true })
        client.destroy()
    })
})
