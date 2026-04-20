# @livequery/rpc

Lightweight RxJS-based RPC utilities for calling services across a SharedWorker boundary.

This package gives you:
- A message channel abstraction for request/response RPC
- A worker-side manager to expose services
- A client-side linker that creates typed service proxies
- Promise-like Observable calls (await or subscribe)
- A persistent BehaviorSubject helper backed by custom storage
- A concurrency-limiting decorator helper

## Installation

```bash
npm install @livequery/rpc rxjs
# or
bun add @livequery/rpc rxjs
```

## Exports

```ts
export * from "./RpcChannel"
export * from "./SharedWorkerChannel"
export * from "./ServiceLinker"
export * from "./WorkerService"
export * from "./WorkerManager"
export * from "./LimitConcurrency"
export * from "./StorageBehaviorSubject"
```

## Architecture

```text
Main Thread                                Shared Worker
-----------                                -------------
ServiceLinker --(RpcMessage)--> SharedWorkerChannel --> WorkerManager --> your service
     ^                                                            |
     |--------------------(response stream)-----------------------|
```

## Quick Start

### 1. Define a service contract

```ts
import { BehaviorSubject, interval, map } from "rxjs"

export class CounterService {
  value = new BehaviorSubject(0)

  increment(by = 1) {
    this.value.next(this.value.getValue() + by)
    return this.value.getValue()
  }

  getCurrent() {
    return this.value.getValue()
  }

  ticker() {
    return interval(1000).pipe(map((i) => `tick-${i}`))
  }
}
```

### 2. Expose the service inside the SharedWorker

```ts
// worker.ts
import { SharedWorkerChannel, WorkerManager } from "@livequery/rpc"
import { CounterService } from "./CounterService"

const channel = new SharedWorkerChannel()
const manager = new WorkerManager(channel)

manager.exposeService("counter", new CounterService())
```

### 3. Link and use the service on the main thread

```ts
// main.ts
import { SharedWorkerChannel, ServiceLinker, type WorkerService } from "@livequery/rpc"
import type { CounterService } from "./CounterService"

const worker = new SharedWorker(new URL("./worker.ts", import.meta.url), { type: "module" })
const channel = new SharedWorkerChannel(worker)
const linker = new ServiceLinker(channel)

const counter = linker.linkService<WorkerService<CounterService>>("counter")

// Await method calls
const next = await counter.increment(2)
console.log(next)

// Read BehaviorSubject-backed state from worker
counter.value.subscribe((v) => console.log("value", v))

// Consume stream responses
const sub = counter.ticker().subscribe((v) => console.log(v))

// Stop stream
sub.unsubscribe()
```

## Core API

## RpcMessage

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

## RpcChannel

Abstract message transport.

```ts
abstract class RpcChannel extends Subject<RpcMessage & {
  respond: (msg: RpcMessage["response"]) => void
}> {
  abstract send(message: RpcMessage): void
}
```

## SharedWorkerChannel

`SharedWorkerChannel` is a concrete `RpcChannel` implementation for both contexts:
- Worker context: `new SharedWorkerChannel()`
- Main thread: `new SharedWorkerChannel(sharedWorker)`

It handles:
- Incoming requests/responses via MessagePort events
- Respond function wiring
- Message dispatch with `send`

## WorkerManager

Worker-side router that executes exposed service members.

```ts
class WorkerManager {
  constructor(channel: RpcChannel)
  exposeService(name: string, service: any): void
}
```

Behavior:
- Resolves nested method paths sent by the client
- Calls functions with args, or returns property values
- Streams Observable-like results back until completion
- Supports cancellation through a `cancel` message
- Adds an internal `____initialize____` method to gather initial values from properties that expose `getValue()`

## ServiceLinker

Main-thread client that builds typed proxies for services.

```ts
class ServiceLinker {
  constructor(channel: RpcChannel)
  linkService<T>(name: string): T
}
```

Behavior:
- Caches proxies by service name
- Sends RPC requests with incrementing request ids
- Returns an Observable for each call
- Returned Observable is Promise-like, so you can use `await`
- Subscriptions automatically send cancellation when unsubscribed
- Initializes BehaviorSubject-like remote state via `____initialize____`

## WorkerService<T>

Type helper that maps a service contract into client-consumable types:
- `BehaviorSubject<U>` stays `BehaviorSubject<U>`
- `Observable<U>` stays `Observable<U>`
- Methods become async-compatible call signatures

```ts
type WorkerService<T> = {
  [K in keyof T]: ...
}
```

Use it to get strong typing for linked services.

## StorageBehaviorSubject<T>

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

Behavior:
- Reads initial value from storage
- Supports sync or async `getItem`
- Writes on every `next`

Example:

```ts
const storage = {
  getItem: <T>(key: string) => JSON.parse(localStorage.getItem(key) || "null") as T | undefined,
  setItem: <T>(key: string, value: T) => localStorage.setItem(key, JSON.stringify(value)),
}

const theme$ = new StorageBehaviorSubject(storage, "theme", "light")
theme$.next("dark")
```

## LimitConcurrency

Decorator factory for queuing decorated method calls and executing them through an internal stream.

```ts
const LimitConcurrency = (limit = 1) => (target, propertyKey, descriptor) => { ... }
```

Usage:

```ts
class Api {
  @LimitConcurrency(1)
  async fetchData(id: string) {
    return { id }
  }
}
```

Notes:
- Works with values, Promises, and Observables
- Returns an Observable that is also Promise-like

## Cancellation Model

If a client unsubscribes from an in-flight call, `ServiceLinker` sends:

```ts
{ id: 0, cancel: { id } }
```

`WorkerManager` listens for that id and stops streaming output for matching Observable calls.

## Build

```bash
bun run build
```

Additional scripts:
- `bun run build:watch`
- `bun run clean`

## Package Info

- Name: `@livequery/rpc`
- ESM output: `dist/index.js`
- Types: `dist/index.d.ts`
- Peer runtime dependency: `rxjs`
