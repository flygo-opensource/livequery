# @livequery/client

Reactive local-first data primitives for browser clients.

This repository is the client library package, not an application. Changes here should preserve reusable public API behavior unless a task explicitly targets a breaking change.

This package provides the core building blocks behind Livequery collections: reactive document state, pluggable local storage, pluggable transporters, optimistic mutations, and typed inline filters.

## AI Agent Guidance

Repository-specific agent guidance lives in `AGENTS.md` and `copilot-instructions.md`.

- `AGENTS.md` is the implementation-focused guide for coding agents modifying this package.
- `copilot-instructions.md` provides repo-level instructions for Copilot when generating or reviewing code in this workspace.
- Both documents assume this repo is a library package, so agent changes should avoid app-specific scaffolding and should preserve public API compatibility by default.
- Agents generating consumer code should also follow the usage patterns documented below: create a shared `LivequeryClient`, initialize collections before querying, and subscribe to collection state instead of relying on one-time `.value` reads.

## Installation

```bash
bun add @livequery/client rxjs
```

For React projects:

```bash
bun add @livequery/client @livequery/react rxjs
```

The package is published as ESM and targets browser usage.

## Public Exports

The package re-exports:

```ts
export * from "./LivequeryCollection"
export * from "./LivequeryClient"
export * from "./LivequeryMemoryStorage"
export * from "./LivequeryStorge"
export * from "./LivequeryTransporter"
export * from "./types"
export * from "./helpers/filterDocs"
export * from "./LivequeryDocument"
```

## Core Types

### `Doc`

Every record must have an `id`.

```ts
type Doc<T = {}> = T & {
  id: string
}
```

### `DocState`

Collections and documents expose `DocState<T>`, which adds optimistic mutation metadata.

```ts
type DocState<T extends Doc> = T & {
  _deleting?: boolean
  _deleting_error?: { code: string; message: string; transporter_id: string }
  _updating?: boolean
  _updating_error?: { code: string; message: string; transporter_id: string }
  _adding?: boolean
  _adding_error?: { code: string; message: string; transporter_id: string }
  _remotes?: Record<string, string | number>
  _prev?: Partial<T>
}
```

### `DataChangeEvent`

Transporters stream incremental change events back into the client.

```ts
type DataChangeEvent = {
  collection_ref: string
  id: string
  type: "added" | "removed" | "modified"
  data?: Record<string, any>
}
```

## Architecture

```text
LivequeryCollection / LivequeryDocument
            |
            v
        LivequeryClient
        /          \
       v            v
LivequeryStorge  LivequeryTransporter(s)
```

- `LivequeryCollection` owns the reactive state for one collection ref or one document ref.
- `LivequeryDocument` wraps an item as a `BehaviorSubject` with convenience mutation methods.
- `LivequeryClient` coordinates storage, transporters, optimistic writes, and fan-out to watchers.
- `LivequeryStorge` is the local persistence contract.
- `LivequeryTransporter` is the remote sync contract.

## Quick Start

```ts
import {
  LivequeryCollection,
  LivequeryClient,
  LivequeryMemoryStorage,
  type Doc,
  type LivequeryQueryResult,
  type LivequeryTransporter,
} from "@livequery/client"
import { of } from "rxjs"

type Todo = Doc<{
  title: string
  done: boolean
  createdAt: number
}>

const storage = new LivequeryMemoryStorage()

const transporter: LivequeryTransporter = {
  query(_query) {
    return of<Partial<LivequeryQueryResult>>({
      changes: [],
      summary: {},
      paging: { total: 0, current: 0 },
      metadata: {},
      source: "query",
    })
  },
  async add(_ref, doc) {
    return { id: crypto.randomUUID(), ...doc } as Todo
  },
  async update(_ref, id, doc) {
    return { id, ...doc } as Todo
  },
  async delete(_ref, id) {
    return { id } as Todo
  },
  async trigger(_action) {
    return { ok: true }
  },
}

const client = new LivequeryClient({
  storage,
  transporters: {
    primary: transporter,
  },
})

const todos = new LivequeryCollection<Todo>(client, {
  filters: { "createdAt:sort": "desc" },
  mode: "server-first",
})

todos.initialize("todos")

todos.items.subscribe((items) => {
  console.log(items.map((doc) => doc.value))
})

await todos.query({ ":limit": 20, "createdAt:sort": "desc" })
await todos.add({ title: "Buy milk", done: false, createdAt: Date.now() })
await todos.update("todo-1", { done: true })
await todos.delete("todo-1")
```

## `LivequeryClient`

Create one client with a storage adapter and one or more transporters:

```ts
const client = new LivequeryClient({
  storage,
  transporters: {
    primary: transporter,
  },
})
```

### Mutation flow

For `add`, `update`, and `delete`, the client:

1. writes to local storage first
2. broadcasts the optimistic change to active watchers
3. pushes the mutation to each transporter
4. clears optimistic flags or stores mutation errors after the remote call finishes

Documents created locally receive ids prefixed with `local:` until a transporter returns a persisted id.

### Query modes

Collections support three modes through `LivequeryCollectionOptions.mode`:

- `server-first`: queries are driven by transporters, and collection state is built from streamed change events.
- `cache-first`: first query can hydrate from local storage, then transporters refresh the result.
- `local-first`: queries resolve from local storage while remote sync runs in the background and rebroadcasts matching changes.

Implementation detail: in `local-first` mode, filters are applied by the storage adapter, while the remote query path is triggered with empty filters and matching is re-checked when added events are broadcast locally.

## `LivequeryCollection`

`LivequeryCollection<T>` manages one collection or one document ref.

```ts
type LivequeryCollectionOptions<T extends Doc> = {
  client: LivequeryClient
  filters: Partial<LivequeryFilters<T>>
  lazy: boolean
  debounce: number
  mode: "server-first" | "local-first" | "cache-first"
}
```

### Create and initialize a collection

The current constructor takes `client` as the first argument and options as the second argument.

```ts
const posts = new LivequeryCollection<Post>(client, {
  filters: { "publishedAt:sort": "desc" },
  lazy: false,
  debounce: 250,
  mode: "cache-first",
})

posts.initialize("posts")
```

`initialize(ref)` subscribes the collection to `LivequeryClient.watch(ref, id, mode)`. In the current implementation, it is browser-only and returns early when `window` is unavailable.

### Collection refs and document refs

If a ref has an even number of path segments, the last segment is treated as a document id.

```ts
posts.initialize("posts")
singlePost.initialize("posts/post-1")
```

For collection mutations, `add`, `update`, and `delete` always target the collection portion of the ref.

### Reactive state

- `items`: `BehaviorSubject<LivequeryDocument<DocState<T>>[]>`
- `summary`: `BehaviorSubject<Record<string, any>>`
- `loading`: `BehaviorSubject<null | "all" | "next" | "prev">`
- `filters`: `BehaviorSubject<Partial<LivequeryFilters<T>>>`
- `paging`: `BehaviorSubject<LivequeryPaging>`
- `error`: `BehaviorSubject<{ code: string; message: string } | null>`

`items` is a `BehaviorSubject`, not a plain array. Reading `collection.items.value` gives the current snapshot only. If you need live updates, subscribe.

```ts
const subscription = posts.items.subscribe((items) => {
  console.log("realtime items", items.map((doc) => doc.value))
})

subscription.unsubscribe()
```

In React, reading only `collection.items.value` during render will not trigger rerenders when new events arrive. Bridge the `BehaviorSubject` into component state.

```tsx
function TodoList({ collection }: { collection: LivequeryCollection<Todo> }) {
  const [items, setItems] = useState(() => collection.items.value)

  useEffect(() => {
    const subscription = collection.items.subscribe(setItems)
    return () => subscription.unsubscribe()
  }, [collection])

  return (
    <ul>
      {items.map((item) => (
        <li key={item.value.id}>{item.value.title}</li>
      ))}
    </ul>
  )
}
```

### Main methods

```ts
query(filters: Partial<LivequeryFilters<T>>): Promise<void>
debounceQuery(filters: Partial<LivequeryFilters<T>>): Promise<void>
loadMore(): Promise<void>
loadPrev(): Promise<void>
loadAround(cursor: string): Promise<void>
add(payload: Partial<T>): Promise<T>
update(id: string, payload: Partial<T>): Promise<T | undefined>
delete(id: string): Promise<void | T | undefined>
trigger<R>(action: string, payload?: Record<string, any>): Observable<{ data: R; error?: Error }> & PromiseLike<R>
resetError(): void
watch(check: (prev: T, next: T) => boolean): Observable<[DocState<T>, DocState<T>]>
```

Notes about current behavior:

- `query()` requires `initialize()` to have run first so the collection has a `ref` and watcher registration.
- `debounceQuery()` only emits through the debounced path when `options.debounce` is truthy.
- `loadMore()` uses `paging.next.cursor` as `:after`.
- `loadPrev()` uses `paging.prev.cursor` as `:before`.
- `loadAround()` currently sets both `:after` and `:before` to the provided cursor.

## `LivequeryDocument`

Each entry inside `collection.items` is a `LivequeryDocument`, which extends `BehaviorSubject<DocState<T>>`.

```ts
class LivequeryDocument<T extends Doc> extends BehaviorSubject<DocState<T>> {
  update(data: Partial<T>): Promise<T | undefined>
  del(): Promise<void | T | undefined>
  trigger<R>(action: string, payload: Record<string, any>): Observable<{ data: R; error?: Error }> & PromiseLike<R>
}
```

Example:

```ts
const first = todos.items.value[0]

first.subscribe((doc) => {
  console.log(doc.title, doc._updating)
})

await first.update({ done: true })
await first.del()

// Observable style
first.trigger("archive", { reason: "completed" }).subscribe()

// Promise-like style
const archived = await first.trigger<{ archived: boolean }>("archive", { reason: "completed" })
console.log(archived.archived)
```

## `LivequeryStorge`

Local persistence adapters must implement:

```ts
type LivequeryStorge = {
  query<T extends Doc>(
    collection: string,
    filters?: Record<string, any>
  ): Promise<{
    documents: T[]
    paging: LivequeryPaging
  }>
  get<T extends Doc>(ref: string, id: string): Promise<T | null>
  add<T extends Doc>(collection: string, document: T): Promise<T>
  update<T extends Doc>(collection: string, id: string, document: Record<string, any>): Promise<T | null>
  delete<T extends Doc>(collection: string, id: string): Promise<T | null>
}
```

The package ships with `LivequeryMemoryStorage`, an in-memory adapter useful for tests, demos, and ephemeral state.

### `LivequeryMemoryStorage`

The built-in adapter:

- stores documents in `Map<string, Map<string, Doc>>`
- generates a local id with `local:${crypto.randomUUID()}` when `id` is missing
- applies filters through the exported `filterDocs()` helper
- supports nested sort keys such as `profile.createdAt:sort`

## `LivequeryTransporter`

Remote adapters must implement:

```ts
type LivequeryTransporter = {
  query<T extends Doc>(query: LivequeryQueryParams<T>): Observable<Partial<LivequeryQueryResult>>
  add<T extends Doc>(ref: string, doc: Omit<T, "id">): Promise<T>
  update<T extends Doc>(ref: string, id: string, doc: Partial<T>): Promise<T>
  delete<T extends Doc>(ref: string, id: string): Promise<T>
  trigger<T>(action: LivequeryAction): Promise<T>
}
```

### Query result shape

```ts
type LivequeryQueryResult = {
  error: { code: string; message: string }
  changes: DataChangeEvent[]
  summary: Record<string, any>
  paging: LivequeryPaging
  metadata: Record<string, any>
  source: "query" | "action" | "realtime"
  loading?: "all" | "next" | "prev" | null
}
```

Transporters can emit partial results. In practice, the most useful fields are `changes`, `paging`, `summary`, `metadata`, and `error`.

## Query Filters

Filters are flat keys derived from the document type.

### Pagination keys

- `:limit`
- `:before`
- `:after`
- `:around`
- `:page`

### Supported operators

- `field:sort` with `"asc" | "desc"` for string and number fields
- `field:gt`, `field:gte`, `field:lt`, `field:lte` for numeric fields
- `field:eq-number` for numeric equality
- `field` for string equality
- `field:in`, `field:nin` for string or number membership
- `field:include` for array containment
- `field:boolean` with `"true" | "false" | "not-true" | "not-false"`
- `field:like` for case-insensitive substring matching on strings
- `field:null` with `"null-only" | "not-null"`

Nested field paths are supported, for example `"profile.createdAt:sort"`.

```ts
await todos.query({
  ":limit": 20,
  "done:boolean": "false",
  "title:like": "milk",
  "createdAt:gte": 1714176000000,
  "createdAt:sort": "desc",
})
```

## Helper Exports

### `filterDocs()`

```ts
import { filterDocs } from "@livequery/client"

const visible = filterDocs(docs, {
  "done:boolean": "false",
  "title:like": "milk",
})
```

### `matchesAllFilters()`

The helper module also exports `matchesAllFilters(doc, filters)` for direct predicate checks.

## Caveats

- `initialize()` is browser-only because it exits early when `window` is unavailable.
- The public storage interface name is intentionally spelled `LivequeryStorge`, matching the source.
- Optimistic flags such as `_adding`, `_updating`, `_deleting`, and `_prev` are system-managed fields.
- Transporter query streams are expected to emit incremental `changes`, not full snapshots.
- `LivequeryCollection` declares a `metadata` subject but does not initialize it in the constructor, so transporter-emitted `metadata` is not safe to rely on yet.
- `trigger()` supports both styles: subscribe as `Observable<{ data, error? }>` or await as a Promise-like value for ergonomic async usage.

## Development

```bash
bun run build
```

Available scripts:

- `bun run clean`
- `bun run build:js`
- `bun run build:types`
- `bun run build`
- `bun run build:watch`
