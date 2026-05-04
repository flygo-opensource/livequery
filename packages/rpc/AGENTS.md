# AGENTS.md

## Purpose

This repository contains `@livequery/rpc`, a small TypeScript library for RPC-style communication between the main thread and a `SharedWorker` using RxJS.

The package focuses on three concerns:

- transport of `RpcMessage` objects
- client-side typed service proxies
- worker-side service dispatch and stream lifecycle management

## Stack And Conventions

- Language: TypeScript, ESM-only
- Package manager preference: Bun
- Build output: `dist/`
- Validation command: `bun run build`
- There is no test suite in this repository today

## Repository Layout

- `src/RpcChannel.ts`: core message contract and abstract transport
- `src/SharedWorkerChannel.ts`: concrete transport for foreground and worker contexts
- `src/ServiceLinker.ts`: client proxy builder, request tracking, cancellation, and observable bridging
- `src/WorkerManager.ts`: worker-side request router and response streaming
- `src/WorkerService.ts`: type mapping from worker service contract to client contract
- `src/LimitConcurrency.ts`: decorator that limits concurrent method execution with RxJS
- `src/RxjsQueue.ts`: simple concurrency-limited async queue
- `src/StorageBehaviorSubject.ts`: `BehaviorSubject` with storage-backed initialization and persistence
- `src/index.ts`: barrel exports only

## Mental Model

The main flow is:

1. `ServiceLinker` creates a proxy for a named service.
2. Proxy access builds a path like `['profile', 'getName']`.
3. Calling that path sends an `RpcMessage` through `RpcChannel`.
4. `WorkerManager` resolves the service and method path, invokes the target, and streams results back.
5. `ServiceLinker` turns the response stream into an `Observable` that is also `PromiseLike`.

This means a remote method can often be consumed either with `await` or with `subscribe()`.

## How To Use The Library

When an agent is asked to add or consume this package in an app, generate code around this shape.

### 1. Define a worker service as a plain class

Use normal class members.

- plain methods for one-shot RPC calls
- `Observable`-returning methods for streams
- `BehaviorSubject` properties for shared state
- nested objects are allowed and can be reached by path

Example:

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
		return interval(1000).pipe(map((index) => `tick-${index}`))
	}

	profile = {
		getName: () => "Ada",
	}
}
```

### 2. Expose the service inside the `SharedWorker`

Inside worker code, create the transport with no constructor argument.

```ts
import { SharedWorkerChannel, WorkerManager } from "@livequery/rpc"
import { CounterService } from "./CounterService"

const channel = new SharedWorkerChannel()
const manager = new WorkerManager(channel)

manager.exposeService("counter", new CounterService())
```

### 3. Connect from the main thread

On the client, instantiate the browser `SharedWorker`, wrap it with `SharedWorkerChannel`, then build a typed proxy with `ServiceLinker`.

```ts
import { ServiceLinker, SharedWorkerChannel, type WorkerService } from "@livequery/rpc"
import type { CounterService } from "./CounterService"

const worker = new SharedWorker(new URL("./worker.ts", import.meta.url), { type: "module" })
const channel = new SharedWorkerChannel(worker)
const linker = new ServiceLinker(channel)

const counter = linker.linkService<WorkerService<CounterService>>("counter")
```

### 4. Consume one-shot methods with `await`

When the worker method returns a plain value or a promise, prefer `await`.

```ts
const nextValue = await counter.increment(2)
```

The runtime object returned by a method call is actually both:

- an `Observable`
- a `PromiseLike` value

So `await counter.increment(2)` works because `ServiceLinker` attaches a custom `then()`.

### 5. Consume streams with `subscribe()`

When the worker method returns an observable-like value, subscribe on the client.

```ts
const subscription = counter.ticker().subscribe((value) => {
	console.log(value)
})

subscription.unsubscribe()
```

Unsubscribing before completion triggers a cancel message back to the worker.

### 6. Read `BehaviorSubject`-style properties like remote state

For remote state, access the property and call `subscribe()`, `pipe()`, or `getValue()` on it.

```ts
const stateSub = counter.value.subscribe((value) => {
	console.log("value", value)
})

const current = counter.value.getValue()
```

Important details:

- `ServiceLinker` special-cases only `subscribe`, `pipe`, and `getValue`
- the first subscription creates and caches the local shared observable for that remote property path
- worker-side state should expose a `getValue()` method if you want current-value semantics; `BehaviorSubject` is the intended shape

### 7. Access nested methods by property path

Nested objects are supported by the proxy.

```ts
const name = await counter.profile.getName()
```

The proxy builds the path lazily from property access and only sends the RPC request when you call the function or subscribe to the observable-like property.

## Usage Rules For Agents

When generating code that uses this library, follow these rules.

- Use `WorkerService<T>` when typing a linked service on the client.
- Use `SharedWorkerChannel()` with no argument in worker code and `SharedWorkerChannel(worker)` in browser code.
- Return RxJS observables from worker methods when the client should stream values.
- Expose `BehaviorSubject` properties directly when the client should observe shared state.
- Keep service APIs free of member names beginning with `#`; those paths are rejected.
- Preserve method `this` binding by exposing service instances, not detached method references.

## What Not To Assume

Agents should not infer features that are not in the current source.

- There is no alternate transport implementation in this repository besides `SharedWorkerChannel`.
- There is no test suite to lean on for behavior discovery.
- `WorkerManager` detects streams by checking for a `pipe()` method, not by RxJS class identity.
- `ServiceLinker` currently does not expose a built-in readiness API in source; do not generate code that depends on one unless you add it.

## Utility Usage

These helpers are independent from the RPC transport and should only be used when the calling code needs their specific behavior.

### `LimitConcurrency`

Use this decorator on async or observable-producing methods when concurrent execution must be capped.

```ts
class ApiService {
	@LimitConcurrency(2)
	fetchItem(id: string) {
		return Promise.resolve({ id })
	}
}
```

### `RxjsQueue`

Use this as a small concurrency-limited task queue outside the RPC layer.

```ts
const queue = new RxjsQueue(2)
const result = await queue.run(() => fetchSomething())
```

### `StorageBehaviorSubject`

Use this when state should initialize from storage and persist on every `next()`.

```ts
const theme$ = new StorageBehaviorSubject(storage, "theme", "light")
theme$.next("dark")
```

## Behavior That Matters When Editing

### Message shape

`RpcMessage` has three mutually relevant branches:

- `request`: `{ service, method, args }`
- `cancel`: `{ id }`
- `response`: `{ data?, error?, completed? }`

Any protocol change must keep `ServiceLinker`, `WorkerManager`, and `SharedWorkerChannel` in sync.

### Client proxy semantics

`ServiceLinker.linkService()` returns a dynamic proxy.

- Property access extends the remote path.
- Function call sends a request.
- `pipe`, `subscribe`, and `getValue` are treated specially to support remote observable-like properties.
- The returned call result is an `Observable` with a custom `then()` implementation.

When changing client call behavior, inspect `ServiceLinker` first. Most user-facing semantics are decided there.

### Cancellation

If a client unsubscribes before a request completes, `ServiceLinker` sends:

```ts
{ id: 0, cancel: { id: requestId } }
```

`WorkerManager` maps request ids to RxJS `Subscription`s and unsubscribes the worker-side stream.

If you touch request cleanup, validate both ends together.

### Observable handling

Worker-side return values are treated like this:

- observable-like values are streamed until completion
- non-observable values are awaited and sent once with `completed: true`
- thrown errors are serialized as `error: string`

Observable detection in `WorkerManager` currently relies on a `pipe()` check, not `instanceof Observable`.

### Path validation

Both `ServiceLinker` and `WorkerManager` reject empty paths or paths beginning with `#`.

If you adjust method-path behavior, keep validation symmetrical on both sides.

### SharedWorker transport split

`SharedWorkerChannel` behaves differently by runtime:

- in worker context (`typeof window == 'undefined'`), it listens for `connect` events and reads from each port
- in foreground context, it listens on `worker.port`

Transport edits should preserve both modes.

## Type Expectations

`WorkerService<T>` maps worker-side members into client-side types:

- `BehaviorSubject<U>` stays `BehaviorSubject<U>`
- `Observable<U>` stays `Observable<U>`
- methods become async call signatures returning `Promise<R>` unless the awaited result is an observable
- nested objects remain nested objects

If a type change affects public API ergonomics, update both `WorkerService.ts` and the runtime behavior in `ServiceLinker.ts` or `WorkerManager.ts` as needed.

## Editing Guidelines For Agents

- Prefer minimal edits. This package is small and behavior is tightly coupled.
- For transport or protocol changes, read the corresponding client and worker file pair before editing.
- For API surface changes, also inspect `src/index.ts` and `package.json` exports.
- Avoid introducing browser-only assumptions into worker code.
- Preserve ESM import style with `.js` extensions in source imports.
- Use existing RxJS patterns instead of adding alternate async abstractions.

## Validation Checklist

After code changes, run:

```bash
bun run build
```

If you change message flow or typing behavior, also manually inspect these files together:

- `src/ServiceLinker.ts`
- `src/WorkerManager.ts`
- `src/WorkerService.ts`

## Known Gaps

- No automated tests are present.
- The repository is optimized for `SharedWorker`; other transports are not implemented here.
- Streaming and promise-like behavior share the same primitive, so seemingly small changes in `ServiceLinker` can alter public API behavior significantly.