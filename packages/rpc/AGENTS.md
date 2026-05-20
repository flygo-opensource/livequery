# AGENTS.md

This file is for AI agents working in or generating code with `@livequery/rpc`. For human-facing usage docs, read `README.md`.

## Purpose

`@livequery/rpc` is a small TypeScript, ESM-only library for RPC-style communication between a main thread and a `SharedWorker` or Chrome extension runtime using RxJS.

The library has three core responsibilities:

- transport `RpcMessage` objects
- build client-side typed service proxies
- dispatch worker-side service calls and manage stream lifecycle

## Repository Facts

- Language: TypeScript
- Module format: ESM-only
- Package manager preference: Bun
- Build output: `dist/`
- Validation: run `bun run test` and `bun run build`
- Source imports must keep `.js` extensions

## File Map

- `src/RpcChannel.ts`: core message contract and abstract channel
- `src/ServiceLinker.ts`: client proxy builder, request tracking, promise-like observable bridging, cancellation
- `src/WorkerManager.ts`: worker-side service registry, path resolution, dispatch, streaming, cancellation
- `src/SharedWorkerChannel.ts`: `SharedWorker` transport for foreground and worker contexts
- `src/ExtensionChannel.ts`: Chrome extension `chrome.runtime` transport
- `src/WorkerService.ts`: worker-to-client type mapping
- `src/LimitConcurrency.ts`: RxJS-based concurrency decorator
- `src/RxjsQueue.ts`: small concurrency-limited async queue
- `src/StorageBehaviorSubject.ts`: storage-backed `BehaviorSubject`
- `src/index.ts`: barrel exports only
- `tests/regression.test.ts`: regression tests for public behavior and fixed edge cases

## Mental Model

1. `ServiceLinker` creates a proxy for a named service.
2. Proxy property access builds a method path such as `["profile", "getName"]`.
3. Function calls or remote property subscriptions send an `RpcMessage`.
4. `WorkerManager` resolves the service and path, invokes the target, and responds.
5. `ServiceLinker` turns responses into an `Observable` that is also `PromiseLike`.

Use `await` for one-shot calls and `subscribe()` for streams.

## Generating Usage Code

When adding this package to an app, generate code around this shape.

Worker service:

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
}
```

Shared worker:

```ts
import { SharedWorkerChannel, WorkerManager } from "@livequery/rpc"
import { CounterService } from "./CounterService"

const channel = new SharedWorkerChannel()
const manager = new WorkerManager(channel)

manager.exposeService("counter", new CounterService())
```

Main thread:

```ts
import { ServiceLinker, SharedWorkerChannel, type WorkerService } from "@livequery/rpc"
import type { CounterService } from "./CounterService"

const worker = new SharedWorker(new URL("./worker.ts", import.meta.url), { type: "module" })
const channel = new SharedWorkerChannel(worker)
const linker = new ServiceLinker(channel)

const counter = linker.linkService<WorkerService<CounterService>>("counter")
```

Chrome extension:

```ts
import { ExtensionChannel, ServiceLinker, WorkerManager, type WorkerService } from "@livequery/rpc"

const channel = new ExtensionChannel()
const linker = new ServiceLinker(channel)
const manager = new WorkerManager(channel)
```

Only use `ExtensionChannel` in contexts where `chrome.runtime` is expected to exist.

## Usage Rules For Agents

- Type linked services as `WorkerService<T>`.
- Use `SharedWorkerChannel()` with no argument in worker code.
- Use `SharedWorkerChannel(worker)` in browser foreground code.
- Return RxJS observables from worker methods when the client should stream values.
- Expose `BehaviorSubject` properties directly when the client should observe shared state.
- Preserve method `this` binding by exposing service instances, not detached method references.
- Do not invent a `ServiceLinker` readiness API; none exists unless you add one.
- Do not use service member names beginning with `#`; those paths are rejected.

## Protocol Contract

`RpcMessage` has three relevant branches:

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

Any protocol change must keep these files aligned:

- `src/RpcChannel.ts`
- `src/ServiceLinker.ts`
- `src/WorkerManager.ts`
- `src/SharedWorkerChannel.ts`
- `src/ExtensionChannel.ts`

## Behavior That Must Be Preserved

- Falsy values are valid RPC data: `0`, `false`, `""`, and `null` must reach the client.
- RPC errors must error the client observable before completion.
- Client unsubscribe before completion sends `{ id: 0, cancel: { id: requestId } }`.
- `WorkerManager` maps request ids to RxJS subscriptions and unsubscribes on cancel.
- Observable-like worker results are detected with a `pipe()` method, not `instanceof Observable`.
- Non-observable worker results are awaited and sent once with `completed: true`.
- Thrown worker errors are serialized as `error: string`.
- Empty paths and paths beginning with `#` are invalid on both client and worker sides.

## Type Expectations

`WorkerService<T>` maps worker-side members into client-side types:

- `BehaviorSubject<U>` stays `BehaviorSubject<U>`
- `Observable<U>` stays `Observable<U>`
- methods become async call signatures returning `Promise<R>` unless the awaited result is an observable
- nested objects remain nested objects

If public type ergonomics change, inspect both runtime behavior and `src/WorkerService.ts`.

## Transport Notes

`SharedWorkerChannel` has two modes:

- worker context: `typeof window == "undefined"`, listens for `connect` events and reads each port
- foreground context: listens on `worker.port`

`ExtensionChannel` has two modes:

- background context: listens on `chrome.runtime.onMessage`, responds via `chrome.tabs.sendMessage` when the sender has a tab id, otherwise via `chrome.runtime.sendMessage`
- foreground context: listens on `chrome.runtime.onMessage` and sends with `chrome.runtime.sendMessage`

Avoid browser-only assumptions in worker code.

## Utility Notes

`LimitConcurrency` must preserve the runtime instance `this` of decorated methods.

`RxjsQueue` defaults to concurrency `1`.

`StorageBehaviorSubject` must preserve synchronous and async falsy stored values; use nullish checks rather than `||` fallback.

## Editing Guidelines

- Prefer minimal edits. The client, worker, and transport layers are tightly coupled.
- For message flow changes, inspect `ServiceLinker` and `WorkerManager` together.
- For transport changes, inspect the relevant channel and `RpcMessage` contract.
- For public API changes, inspect `src/index.ts`, `package.json` exports, and `README.md`.
- Use existing RxJS patterns instead of introducing another async abstraction.
- Keep generated tests focused on public behavior and regressions.

## Validation Checklist

After code changes, run:

```bash
bun run test
bun run build
```

For message flow or typing changes, manually inspect:

- `src/ServiceLinker.ts`
- `src/WorkerManager.ts`
- `src/WorkerService.ts`

## Known Gaps

- Test coverage is intentionally small and regression-focused.
- The package is optimized for `SharedWorker`; `ExtensionChannel` is available for Chrome extension runtime messaging.
- Streaming and promise-like behavior share the same primitive, so small `ServiceLinker` changes can alter public behavior.
