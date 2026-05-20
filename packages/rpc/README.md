# @livequery/rpc

Small TypeScript utilities for RPC-style communication between a main thread and a `SharedWorker` or Chrome extension runtime. It uses RxJS for request streams, cancellation, and observable state.

Use it when you want a service-style API across a worker boundary instead of manually passing `postMessage` objects around.

## Install

```bash
bun add @livequery/rpc rxjs
```

```bash
npm install @livequery/rpc rxjs
```

## Core Idea

```text
Main thread                          Worker or extension runtime
-----------                          ---------------------------
ServiceLinker -- RpcMessage -------> WorkerManager -> service instance
     ^                                      |
     |----------- response stream ----------|
```

- `ServiceLinker` creates a typed client proxy.
- `WorkerManager` exposes service instances and dispatches incoming calls.
- `SharedWorkerChannel` transports messages over `SharedWorker`.
- `ExtensionChannel` transports messages over `chrome.runtime`.
- `WorkerService<T>` maps a worker-side service type into the client-side type.

## SharedWorker Example

### 1. Define a service

```ts
import { BehaviorSubject, interval, map } from "rxjs"

export class CounterService {
  value = new BehaviorSubject(0)

  increment(by = 1) {
    const nextValue = this.value.getValue() + by
    this.value.next(nextValue)
    return nextValue
  }

  ticker() {
    return interval(1000).pipe(map(index => `tick-${index}`))
  }

  profile = {
    getName: () => "Ada",
  }
}
```

### 2. Expose it in the worker

```ts
import { SharedWorkerChannel, WorkerManager } from "@livequery/rpc"
import { CounterService } from "./CounterService"

const channel = new SharedWorkerChannel()
const manager = new WorkerManager(channel)

manager.exposeService("counter", new CounterService())
```

### 3. Connect from the main thread

```ts
import { ServiceLinker, SharedWorkerChannel, type WorkerService } from "@livequery/rpc"
import type { CounterService } from "./CounterService"

const worker = new SharedWorker(new URL("./worker.ts", import.meta.url), { type: "module" })
const channel = new SharedWorkerChannel(worker)
const linker = new ServiceLinker(channel)

const counter = linker.linkService<WorkerService<CounterService>>("counter")
```

### 4. Call methods

Use `await` for one-shot values:

```ts
const nextValue = await counter.increment(2)
```

Use `subscribe()` for streamed values:

```ts
const subscription = counter.ticker().subscribe(value => {
  console.log(value)
})

subscription.unsubscribe()
```

Nested methods work through normal property access:

```ts
const name = await counter.profile.getName()
```

## Remote State

Expose a `BehaviorSubject` property on the worker service when the client should observe shared state:

```ts
const subscription = counter.value.subscribe(value => {
  console.log("counter value", value)
})

const current = counter.value.getValue()
```

Notes:

- `subscribe`, `pipe`, and `getValue` are special-cased for remote observable-like properties.
- The first subscription creates and caches the local shared observable for that property path.
- `getValue()` reads the local cache. Subscribe first if you need the current worker value to be populated.

## Chrome Extension Runtime

Use `ExtensionChannel` inside Chrome extension contexts where `chrome.runtime` is available.

Background service worker:

```ts
import { ExtensionChannel, WorkerManager } from "@livequery/rpc"
import { CounterService } from "./CounterService"

const channel = new ExtensionChannel()
const manager = new WorkerManager(channel)

manager.exposeService("counter", new CounterService())
```

Popup, options page, or content script:

```ts
import { ExtensionChannel, ServiceLinker, type WorkerService } from "@livequery/rpc"
import type { CounterService } from "./CounterService"

const channel = new ExtensionChannel()
const linker = new ServiceLinker(channel)

const counter = linker.linkService<WorkerService<CounterService>>("counter")
```

`ExtensionChannel` auto-detects foreground versus background context. If `chrome` is unavailable, operations silently no-op.

## Call Behavior

Every remote method call returns an `Observable` with a custom `then()` implementation. That means the same call can often be used as either:

```ts
const result = await service.someMethod()
```

or:

```ts
const subscription = service.someMethod().subscribe(value => {
  console.log(value)
})
```

For clarity, prefer:

- `await` for plain values and promises
- `subscribe()` for observable streams

If a client unsubscribes before a request completes, a cancellation message is sent to the worker and `WorkerManager` unsubscribes from the worker-side stream.

## Utility Helpers

### `LimitConcurrency`

Decorator for limiting concurrent method execution:

```ts
import { LimitConcurrency } from "@livequery/rpc"

class ApiService {
  @LimitConcurrency(2)
  async fetchItem(id: string) {
    return { id }
  }
}
```

### `RxjsQueue`

Small concurrency-limited async queue:

```ts
import { RxjsQueue } from "@livequery/rpc"

const queue = new RxjsQueue(2)
const result = await queue.run(() => fetchSomething())
```

The default concurrency is `1`.

### `StorageBehaviorSubject`

`BehaviorSubject` that initializes from storage and persists every `next()`:

```ts
import { StorageBehaviorSubject } from "@livequery/rpc"

const theme$ = new StorageBehaviorSubject(storage, "theme", "light")
theme$.next("dark")
```

The storage adapter shape is:

```ts
type IStorage = {
  getItem: <T>(key: string) => Promise<T | undefined> | T | undefined
  setItem: <T>(key: string, value: T) => void
}
```

## Exports

```ts
export * from "./RpcChannel.js"
export * from "./ExtensionChannel.js"
export * from "./SharedWorkerChannel.js"
export * from "./ServiceLinker.js"
export * from "./WorkerService.js"
export * from "./WorkerManager.js"
export * from "./LimitConcurrency.js"
export * from "./StorageBehaviorSubject.js"
export * from "./RxjsQueue.js"
```

## Constraints

- Service paths beginning with `#` are invalid.
- Worker streams are detected by checking for a `pipe()` method.
- Falsy values such as `0`, `false`, `""`, and `null` are valid RPC payloads.
- Errors are propagated to the client as `Error(message)`.
- There is no built-in readiness API in `ServiceLinker`.

## Development

```bash
bun run test
bun run build
```

Build output is written to `dist/`.
