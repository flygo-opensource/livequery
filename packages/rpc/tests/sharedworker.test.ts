import { afterEach, describe, expect, test } from "bun:test"
import { Observable } from "rxjs"
import { ServiceLinker } from "../src/ServiceLinker.js"
import { WorkerManager } from "../src/WorkerManager.js"
import { SharedWorkerChannel } from "../src/SharedWorkerChannel.js"

const tick = (ms = 30) => new Promise<void>((r) => setTimeout(r, ms))

// Wire a foreground SharedWorkerChannel and a background SharedWorkerChannel together through a
// real MessageChannel — the same async, structured-clone transport a real SharedWorker uses.
//
// NOTE: #initBackground subscribes to `connect` on globalThis and never tears it down (correct
// for a real SharedWorker, whose global lives for the worker's lifetime). So this file uses a
// SINGLE background connection for the whole suite — creating multiple backgrounds in one
// process would cross-wire, because a stale background also receives later `connect` events.
function connectSharedWorker() {
    const hadWindow = "window" in globalThis
    const prevWindow = (globalThis as any).window
    const mc = new MessageChannel()

    delete (globalThis as any).window
    const background = new SharedWorkerChannel()

    ;(globalThis as any).window = {}
    const foreground = new SharedWorkerChannel({ port: mc.port1 } as any)

    const ev: any = new Event("connect")
    ev.ports = [mc.port2]
    globalThis.dispatchEvent(ev)

    return {
        foreground,
        background,
        restore() {
            mc.port1.close()
            mc.port2.close()
            if (hadWindow) (globalThis as any).window = prevWindow
            else delete (globalThis as any).window
        },
    }
}

let cleanup: (() => void) | undefined
afterEach(() => { cleanup?.(); cleanup = undefined })

describe("RPC over SharedWorkerChannel (real MessagePorts)", () => {
    test("method calls and observable streaming work across the port boundary", async () => {
        const { foreground, background, restore } = connectSharedWorker()
        cleanup = restore

        const manager = new WorkerManager(background)
        const linker = new ServiceLinker(foreground)

        // Worker-side observable source (lives inside the worker in a real app). It emits AFTER
        // the worker subscribes, spaced apart — mirroring real worker data production.
        let workerSubscriptions = 0
        const stream$ = new Observable<number>((s) => {
            workerSubscriptions++
            const t1 = setTimeout(() => s.next(10), 10)
            const t2 = setTimeout(() => s.next(20), 70)
            return () => { clearTimeout(t1); clearTimeout(t2) }
        })
        manager.exposeService("s", {
            greet: (name: string) => `hi ${name}`,
            stream$,
        })
        const svc = linker.linkService<any>("s")

        // 1) Request/response method call over the port.
        expect(await svc.greet("ada")).toBe("hi ada")

        // 2) Observable streaming — clean (no leading null), correct order, single subscription.
        const got: number[] = []
        svc.stream$.subscribe((v: number) => got.push(v))
        await tick(160)

        expect(got).toEqual([10, 20])
        expect(workerSubscriptions).toBe(1)
        expect(svc.stream$.getValue()).toBe(20)
    })
})
