import { describe, expect, test } from "bun:test"
import { BehaviorSubject, map } from "rxjs"
import { RpcChannel, type RpcMessage } from "../src/RpcChannel.js"
import { ServiceLinker } from "../src/ServiceLinker.js"
import { WorkerManager } from "../src/WorkerManager.js"

class MemoryChannel extends RpcChannel {
    peer?: MemoryChannel
    send(message: RpcMessage): void {
        this.peer?.next({
            ...message,
            respond: (response) => {
                this.next({ id: message.id, response, respond: () => undefined })
            },
        })
    }
}

function createRpcPair() {
    const client = new MemoryChannel()
    const worker = new MemoryChannel()
    client.peer = worker
    worker.peer = client
    return { client, worker }
}

const tick = (ms = 10) => new Promise<void>((r) => setTimeout(r, ms))

describe("RPC observable streaming", () => {
    test("subscribe to a remote BehaviorSubject receives its values", async () => {
        const { client, worker } = createRpcPair()
        const manager = new WorkerManager(worker)
        const linker = new ServiceLinker(client)

        const counter$ = new BehaviorSubject(1)
        manager.exposeService("s", { counter$ })
        const svc = linker.linkService<any>("s")

        const got: any[] = []
        svc.counter$.subscribe((v: any) => got.push(v))
        await tick()
        counter$.next(2)
        counter$.next(3)
        await tick()

        // What does the consumer actually receive?
        console.log("RECEIVED:", JSON.stringify(got))
        expect(got).toEqual([1, 2, 3])
    })

    test("getValue() reflects the latest emitted value", async () => {
        const { client, worker } = createRpcPair()
        const manager = new WorkerManager(worker)
        const linker = new ServiceLinker(client)

        const counter$ = new BehaviorSubject(10)
        manager.exposeService("s", { counter$ })
        const svc = linker.linkService<any>("s")

        svc.counter$.subscribe(() => undefined)
        await tick()
        counter$.next(20)
        await tick()

        console.log("GETVALUE:", svc.counter$.getValue())
        expect(svc.counter$.getValue()).toBe(20)
    })

    test("pipe(map) transforms remote values", async () => {
        const { client, worker } = createRpcPair()
        const manager = new WorkerManager(worker)
        const linker = new ServiceLinker(client)

        const counter$ = new BehaviorSubject(2)
        manager.exposeService("s", { counter$ })
        const svc = linker.linkService<any>("s")

        const got: any[] = []
        svc.counter$.pipe(map((v: number) => (v ?? 0) * 10)).subscribe((v: any) => got.push(v))
        await tick()
        counter$.next(5)
        await tick()

        console.log("PIPED:", JSON.stringify(got))
        expect(got).toEqual([20, 50])
    })
})
