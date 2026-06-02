import { describe, expect, test } from "bun:test"
import { BehaviorSubject, Observable } from "rxjs"
import { LimitConcurrency } from "../src/LimitConcurrency.js"
import type { RpcMessage } from "../src/RpcChannel.js"
import { RpcChannel } from "../src/RpcChannel.js"
import { RxjsQueue } from "../src/RxjsQueue.js"
import { ServiceLinker } from "../src/ServiceLinker.js"
import { StorageBehaviorSubject } from "../src/StorageBehaviorSubject.js"
import { WorkerManager } from "../src/WorkerManager.js"

class MemoryChannel extends RpcChannel {
    peer?: MemoryChannel

    send(message: RpcMessage): void {
        this.peer?.next({
            ...message,
            respond: response => {
                this.next({
                    id: message.id,
                    response,
                    respond: () => undefined,
                })
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

function withTimeout<T>(promise: Promise<T>, ms = 100) {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) => {
            setTimeout(() => reject(new Error("Timed out")), ms)
        }),
    ])
}

describe("RPC regression behavior", () => {
    test("ServiceLinker forwards falsy response data", async () => {
        const { client, worker } = createRpcPair()
        const manager = new WorkerManager(worker)
        const linker = new ServiceLinker(client)

        manager.exposeService("values", {
            zero: () => 0,
            no: () => false,
            empty: () => "",
            nil: () => null,
        })

        const values = linker.linkService<any>("values")

        expect(await values.zero()).toBe(0)
        expect(await values.no()).toBe(false)
        expect(await values.empty()).toBe("")
        expect(await values.nil()).toBeNull()
    })

    test("WorkerManager returns a clear error for invalid nested paths", async () => {
        const { client, worker } = createRpcPair()
        const manager = new WorkerManager(worker)
        const linker = new ServiceLinker(client)

        manager.exposeService("values", {
            profile: undefined,
        })

        const values = linker.linkService<any>("values")

        try {
            await values.profile.getName()
            throw new Error("Expected invalid path to reject")
        } catch (error) {
            expect(error).toBeInstanceOf(Error)
            expect((error as Error).message).toBe("Invalid method path: getName")
        }
    })

    test("WorkerManager blocks prototype-chain access (constructor)", async () => {
        const { client, worker } = createRpcPair()
        const manager = new WorkerManager(worker)
        const linker = new ServiceLinker(client)

        manager.exposeService("svc", { hello: () => "hi" })
        const svc = linker.linkService<any>("svc")

        try {
            await svc.constructor.constructor("return 1")
            throw new Error("Expected forbidden path to reject")
        } catch (error) {
            expect((error as Error).message).toContain("Invalid method path")
        }
    })

    test("worker errors propagate the worker-side stack", async () => {
        const { client, worker } = createRpcPair()
        const manager = new WorkerManager(worker)
        const linker = new ServiceLinker(client)

        manager.exposeService("boom", {
            fail: () => { throw new Error("kaboom") },
        })
        const svc = linker.linkService<any>("boom")

        try {
            await svc.fail()
            throw new Error("Expected fail() to reject")
        } catch (error) {
            expect((error as Error).message).toBe("kaboom")
            expect((error as Error).stack).toContain("kaboom")
        }
    })

    test("disconnect releases streaming subscriptions for that connection", async () => {
        const { client, worker } = createRpcPair()
        const manager = new WorkerManager(worker)
        const linker = new ServiceLinker(client)

        let torndown = false
        const stream$ = new Observable(() => () => { torndown = true })
        manager.exposeService("live", { data$: () => stream$ })

        const svc = linker.linkService<any>("live")
        svc.data$.subscribe(() => undefined)
        await new Promise(r => setTimeout(r, 10))

        // Simulate the channel reporting the connection dropped (connection_id matches
        // the request's — both undefined for MemoryChannel).
        worker.next({ id: 0, disconnect: true, respond: () => undefined })
        await new Promise(r => setTimeout(r, 10))

        expect(torndown).toBe(true)
    })
})

describe("utility regression behavior", () => {
    test("RxjsQueue processes tasks with the default concurrency limit", async () => {
        const queue = new RxjsQueue()

        await expect(withTimeout(queue.run(async () => 42))).resolves.toBe(42)
    })

    test("StorageBehaviorSubject preserves synchronous falsy stored values", () => {
        const storage = {
            getItem: <T>(key: string) => {
                const values: Record<string, unknown> = {
                    zero: 0,
                    no: false,
                    empty: "",
                }
                return values[key] as T
            },
            setItem: () => undefined,
        }

        expect(new StorageBehaviorSubject(storage, "zero", 10).getValue()).toBe(0)
        expect(new StorageBehaviorSubject(storage, "no", true).getValue()).toBe(false)
        expect(new StorageBehaviorSubject(storage, "empty", "fallback").getValue()).toBe("")
    })

    test("LimitConcurrency preserves the instance this binding", async () => {
        class Counter {
            value = new BehaviorSubject(2)

            async add(by: number) {
                return this.value.getValue() + by
            }
        }

        const descriptor = Object.getOwnPropertyDescriptor(Counter.prototype, "add")
        if (!descriptor) throw new Error("Missing descriptor")

        LimitConcurrency(1)(Counter.prototype, "add", descriptor)
        Object.defineProperty(Counter.prototype, "add", descriptor)

        const counter = new Counter()

        expect(await counter.add(3)).toBe(5)
    })
})
