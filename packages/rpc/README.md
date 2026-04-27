# @livequery/rpc

Lightweight RxJS-based RPC utilities for exposing services from a `SharedWorker` and consuming them from the main thread with typed proxies.

This package is built for a simple model:

- Expose plain classes as worker services.
- Call worker methods from the UI as `await`-able functions.
- Stream worker `Observable`s back to the client.
- Mirror `BehaviorSubject`-style state across the boundary.
- Cancel long-running streams when the client unsubscribes.

## Installation

```bash
npm install @livequery/rpc rxjs
```

Or with Bun:

```bash
bun add @livequery/rpc rxjs
```

## What It Exports

```ts
export * from "./RpcChannel"
export * from "./SharedWorkerChannel"
export * from "./ServiceLinker"
export * from "./WorkerService"
export * from "./WorkerManager"
export * from "./LimitConcurrency"
export * from "./StorageBehaviorSubject"
export * from "./RxjsQueue"
```

## Mental Model

```text
Main Thread                                Shared Worker
-----------                                -------------
ServiceLinker --(RpcMessage)--> SharedWorkerChannel --> WorkerManager --> your service
     ^                                                            |
     |--------------------(response stream)-----------------------|
```

## When To Use This Package

Use it when you want to:

- move logic or shared state into a `SharedWorker`
- keep a typed service-style API instead of manually handling `postMessage`
- return one-shot values, promises, or `Observable`s from worker methods
- expose `BehaviorSubject` properties as client-consumable reactive state

## End-To-End Example

### 1. Define a worker service

```ts
import { BehaviorSubject, interval, map } from "rxjs"

export class CounterService {
  value = new BehaviorSubject(0)

  increment(by = 1) {
    const nextValue = this.value.getValue() + by
    this.value.next(nextValue)
    return nextValue
  }

  getCurrent() {
    return this.value.getValue()
  }

  ticker() {
    return interval(1000).pipe(map((index) => `tick-${index}`))
  }
}
```

### 2. Expose it inside the `SharedWorker`

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

### 4. Call methods with `await`

```ts
const nextValue = await counter.increment(2)
const currentValue = await counter.getCurrent()

console.log({ nextValue, currentValue })
```

### 5. Subscribe to streamed responses

```ts
const tickerSubscription = counter.ticker().subscribe((value) => {
  console.log("tick", value)
})

setTimeout(() => {
  tickerSubscription.unsubscribe()
}, 5000)
```

### 6. Consume `BehaviorSubject` state

```ts
const stateSubscription = counter.value.subscribe((value) => {
  console.log("counter value", value)
})
```

## How Calls Behave

Every service method call is exposed on the client as an `Observable` that is also `PromiseLike`.

That means you can do either of these:

```ts
const result = await service.someMethod()
```

```ts
service.someMethod().subscribe((value) => {
  console.log(value)
})
```

In practice:

- use `await` for one-shot values or promise-returning methods
- use `subscribe()` for streaming results returned from worker `Observable`s

## BehaviorSubject Mirroring

If your service exposes a property with a `getValue()` method, `WorkerManager` will include its initial value during service initialization.

This is what allows a worker-side `BehaviorSubject` to feel usable on the client:

```ts
class SettingsService {
  theme = new BehaviorSubject("light")
}
```

```ts
const settings = linker.linkService<WorkerService<SettingsService>>("settings")

settings.theme.subscribe((theme) => {
  console.log(theme)
})
```

Notes:

- the initial snapshot is fetched through an internal `____initialize____` call
- later updates are streamed by subscribing to the remote property
- this pattern is designed around `BehaviorSubject`-like objects

## Waiting For Multiple Services To Initialize

`ServiceLinker` exposes a helper for waiting until all linked services have loaded their initial state.

```ts
const counter = linker.linkService<WorkerService<CounterService>>("counter")
const settings = linker.linkService<WorkerService<SettingsService>>("settings")

ServiceLinker.ready$({ counter, settings }).subscribe((ready) => {
  if (ready) {
    console.log("all services initialized")
  }
})
```

## Nested Access

The client proxy supports nested member access by path.

For example, a worker service like this:

```ts
class UserService {
  profile = {
    getName: () => "Ada",
  }
}
```

can be consumed like this:

```ts
const user = linker.linkService<WorkerService<UserService>>("user")
const name = await user.profile.getName()
```

## Cancellation Model

If a client unsubscribes from an in-flight request before it completes, `ServiceLinker` sends a cancellation message:

```ts
{ id: 0, cancel: { id: requestId } }
```

`WorkerManager` uses that request id to unsubscribe from the worker-side stream.

This mainly matters for:

- infinite or long-lived `Observable`s
- expensive operations you no longer need
- UI screens that mount and unmount frequently

## API Reference

### `RpcMessage`

```ts
type RpcMessage = {
  id: number
  request?: {
    service: string
    method: string[]
    args: any[]
  }
  cancel?: { id: number }
  response?: Partial<{
    data: any
    error: string
    completed: boolean
  }>
}
```

### `RpcChannel`

Abstract transport used by both client and worker.

```ts
abstract class RpcChannel extends Subject<
  RpcMessage & { respond: (msg: RpcMessage["response"]) => void }
> {
  abstract send(message: RpcMessage): void
}
```

### `SharedWorkerChannel`

Concrete `RpcChannel` implementation for a `SharedWorker` transport.

Worker side:

```ts
const channel = new SharedWorkerChannel()
```

Main thread side:

```ts
const worker = new SharedWorker(new URL("./worker.ts", import.meta.url), { type: "module" })
const channel = new SharedWorkerChannel(worker)
```

### `WorkerManager`

Registers named services and routes incoming RPC requests.

```ts
class WorkerManager {
  constructor(channel: RpcChannel)
  exposeService(name: string, service: any): void
}
```

Behavior:

- resolves nested property or method paths
- invokes functions with arguments
- returns plain values for property access
- streams observable-like results until completion
- unsubscribes worker-side streams when cancellation arrives

### `ServiceLinker`

Creates and caches client-side proxies.

```ts
class ServiceLinker {
  constructor(channel: RpcChannel)
  linkService<T>(name: string): WorkerService<T>
  static ready$(services: Record<string, any>): Observable<boolean>
}
```

Behavior:

- caches proxies by service name
- assigns incrementing request ids
- returns an `Observable` that is also `PromiseLike`
- sends cancellation when a request is unsubscribed early
- initializes `BehaviorSubject`-style values via `____initialize____`

### `WorkerService<T>`

Type helper that converts a worker-side contract into a client-side contract.

Rules:

- `BehaviorSubject<T>` stays `BehaviorSubject<T>`
- `Observable<T>` stays `Observable<T>`
- methods become async call signatures

Example:

```ts
type CounterClient = WorkerService<CounterService>
```

## Utility Helpers

### `StorageBehaviorSubject<T>`

`BehaviorSubject` with persistence hooks.

```ts
type IStorage = {
  getItem: <T>(key: string) => Promise<T | undefined> | T | undefined
  setItem: <T>(key: string, value: T) => void
}

class StorageBehaviorSubject<T> extends BehaviorSubject<T> {
  constructor(storage: IStorage, key: string, defaultValue: T)
  next(value: T): void
}
```

Example:

```ts
const storage = {
  getItem: <T>(key: string) => JSON.parse(localStorage.getItem(key) || "null") as T | undefined,
  setItem: <T>(key: string, value: T) => {
    localStorage.setItem(key, JSON.stringify(value))
  },
}

const theme$ = new StorageBehaviorSubject(storage, "theme", "light")
theme$.next("dark")
```

### `LimitConcurrency`

Decorator factory that queues method calls and executes them with a concurrency cap.

```ts
class ApiService {
  @LimitConcurrency(2)
  async fetchItem(id: string) {
    return { id }
  }
}
```

Useful when you want a service method to:

- limit concurrent async work
- preserve a simple call API
- still return something `await`-able or subscribable

### `RxjsQueue`

Simple promise queue built on RxJS operators.

```ts
const queue = new RxjsQueue(2)

const result = await queue.run(async () => {
  return doWork()
})
```

Use `updateLimit()` to change concurrency at runtime.

## Constraints And Assumptions

Keep these implementation details in mind:

- transport is specifically designed around `SharedWorker`
- service member paths beginning with `#` are treated as invalid
- missing services return an RPC error response
- errors are propagated back as `Error(message)` on the client
- worker-to-client state mirroring is optimized for `BehaviorSubject`-style fields

## Build

```bash
bun run build
```

Other scripts:

- `bun run clean`
- `bun run build:js`
- `bun run build:types`
- `bun run build:watch`

## Package Output

- ESM entry: `dist/index.js`
- type declarations: `dist/index.d.ts`
- package name: `@livequery/rpc`
