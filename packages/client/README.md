# @livequery/core

Reactive local-first data primitives for browser clients. The package combines RxJS-based collections, pluggable local storage, pluggable remote transporters, optimistic mutations, and typed inline filters.

This package is only the core layer. You can use the built-in pieces, but you can also implement your own `LivequeryStorge` and `LivequeryTransporter` adapters to match your cache strategy, backend API, realtime channel, or persistence model.

## Installation

```bash
npm install @livequery/core rxjs
# or
bun add @livequery/core rxjs
```

For React projects:

```bash
npm install @livequery/core @livequery/react rxjs
# or
bun add @livequery/core @livequery/react rxjs
```

The package is published as ESM and targets browser usage.

If you are using this package with React, `@livequery/react` is the recommended companion package so collection state can be connected to React components more ergonomically.

## Public Exports

The public API is re-exported from `src/index.ts`:

```ts
export * from "./LivequeryCollection"
export * from "./LivequeryCore"
export * from "./LivequeryMemoryStorage"
export * from "./LivequeryStorge"
export * from "./LivequeryTransporter"
export * from "./types"
export * from "./helpers/filterDocs"
export * from "./LivequeryDocument"
```

## Core Concepts

### `Doc`

Every record must have an `id`.

```ts
type Doc<T = {}> = T & {
  id: string
}
```

### `DocState`

Collections expose documents as `DocState<T>`, which adds optimistic mutation metadata.

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

Remote query streams feed the core with incremental changes:

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
        LivequeryCore
        /          \
       v            v
LivequeryStorge  LivequeryTransporter(s)
```

- `LivequeryCollection` manages reactive state for one collection or document ref.
- `LivequeryDocument` wraps one item as a `BehaviorSubject` with convenience mutation methods.
- `LivequeryCore` coordinates storage, transporters, optimistic writes, and broadcast fan-out.
- `LivequeryStorge` is the local persistence contract.
- `LivequeryTransporter` is the remote sync contract.

## Quick Start

```ts
import {
  LivequeryCollection,
  LivequeryCore,
  LivequeryMemoryStorage,
  type Doc,
  type LivequeryQueryResult,
  type LivequeryTransporter,
} from "@livequery/core"
import { of } from "rxjs"

type Todo = Doc<{
  title: string
  done: boolean
  createdAt: number
}>

const storage = new LivequeryMemoryStorage()

const transporter: LivequeryTransporter = {
  query() {
    return of<Partial<LivequeryQueryResult>>({
      changes: [],
      summary: {},
      paging: { total: 0, current: 0 },
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

const core = new LivequeryCore({
  storage,
  transporters: {
    primary: transporter,
  },
})

const todos = new LivequeryCollection<Todo>({
  filters: { "createdAt:sort": "desc" },
  mode: "server-first",
})

todos.initialize(core, "todos")

todos.items.subscribe((items) => {
  console.log(items.map((doc) => doc.value))
})

await todos.query({ ":limit": 20, "createdAt:sort": "desc" })
await todos.add({ title: "Buy milk", done: false, createdAt: Date.now() })
await todos.update("todo-1", { done: true })
await todos.delete("todo-1")
```

## `LivequeryCore`

Create one core with a storage adapter and one or more transporters:

```ts
const core = new LivequeryCore({
  storage,
  transporters: {
    primary: transporter,
  },
})
```

### Mutation flow

For `add`, `update`, and `delete`, the core:

1. writes to local storage first
2. broadcasts the optimistic change to active watchers
3. pushes the mutation to each transporter
4. clears optimistic flags or stores mutation errors after the remote call finishes

Documents created locally receive ids prefixed with `local:` until a transporter returns a persisted id.

### Query modes

Collections support three modes through `LivequeryCollectionOptions.mode`:

- `server-first`: collection reads are driven by the transporter layer. In practice, the collection waits for remote query results and builds state from transporter events.
- `cache-first`: the collection reads from local cache first, then pulls fresh data from the transporter and merges the result back in.
- `local-first`: the collection reads only from local cache for the query result, applies filters at the storage layer, then performs background synchronization so remote changes are applied silently afterward.

Current implementation detail: in `local-first` mode, active filters are not forwarded to the transporter. The query result is filtered by the storage adapter, and added events are filtered again before they are rebroadcast into matching collections.

## `LivequeryCollection`

`LivequeryCollection<T>` manages one collection or one document ref.

```ts
type LivequeryCollectionOptions<T extends Doc> = {
  filters: Partial<LivequeryFilters<T>>
  lazy: boolean
  debounce: number
  mode: "server-first" | "local-first" | "cache-first"
}
```

### Initialize a collection

```ts
const posts = new LivequeryCollection<Post>({
  filters: { "publishedAt:sort": "desc" },
  lazy: false,
  debounce: 250,
  mode: "cache-first",
})

posts.initialize(core, "posts")
```

`initialize()` subscribes the collection to `LivequeryCore.watch(ref, id, mode)`. In the current implementation, it is browser-only and returns early when `window` is unavailable.

### Reactive state

- `items`: `BehaviorSubject<LivequeryDocument<DocState<T>>[]>`
- `summary`: `BehaviorSubject<Record<string, any>>`
- `loading`: `BehaviorSubject<null | "all" | "next" | "prev">`
- `filters`: `BehaviorSubject<Partial<LivequeryFilters<T>>>`
- `paging`: `BehaviorSubject<LivequeryPaging>`
- `error`: `BehaviorSubject<{ code: string; message: string } | null>`

`items` is a `BehaviorSubject`, not a plain array. Reading `collection.items.value` gives you the current snapshot only. If you need live updates, you must subscribe.

```ts
const subscription = posts.items.subscribe((items) => {
  console.log("realtime items", items.map((doc) => doc.value))
})

// later
subscription.unsubscribe()
```

In React, using only `collection.items.value` during render will not cause rerenders when new events arrive. Bridge the `BehaviorSubject` into React state with `subscribe()`.

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
trigger<R>(action: string, payload?: Record<string, any>): Observable<{ data: R; error?: Error }>
resetError(): void
watch(check: (prev: T, next: T) => boolean): Observable<[DocState<T>, DocState<T>]>
```

### Collection refs and document refs

If a ref has an even number of path segments, the last segment is treated as a document id.

```ts
posts.initialize(core, "posts")
singlePost.initialize(core, "posts/post-1")
```

## `LivequeryDocument`

Each item inside `collection.items` is a `LivequeryDocument`, which extends `BehaviorSubject<DocState<T>>`.

```ts
class LivequeryDocument<T extends Doc> extends BehaviorSubject<DocState<T>> {
  update(data: Partial<T>): Promise<T | undefined>
  del(): Promise<void | T | undefined>
  trigger<R>(action: string, payload: Record<string, any>): Observable<{ data: R; error?: Error }>
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
first.trigger("archive", { reason: "completed" }).subscribe()
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

Behavior of the built-in adapter:

- stores documents in `Map<string, Map<string, Doc>>`
- generates a local id with `local:${crypto.randomUUID()}` when `id` is missing
- supports nested sort paths such as `profile.createdAt:sort`
- applies filters with the exported `filterDocs()` helper

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

Transporters can emit partial results. In practice, the most important fields are `changes`, `paging`, `summary`, and `error`.

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
import { filterDocs } from "@livequery/core"

const visible = filterDocs(docs, {
  "done:boolean": "false",
  "title:like": "milk",
})
```

### `matchesAllFilters()`

The helper module also exports `matchesAllFilters(doc, filters)` for direct predicate checks.

## Notes

- `initialize()` is browser-only in the current implementation
- the public storage interface name is spelled `LivequeryStorge`, matching the source
- optimistic flags such as `_adding`, `_updating`, and `_deleting` are system fields managed by the core
- remote query streams are expected to emit `changes` rather than full snapshots
- `LivequeryCollection` declares a `metadata` field, but it is not initialized in the current constructor, so transporter-emitted `metadata` is not safe to rely on through the collection API yet
- `trigger()` is typed as `Observable<{ data, error? }>` at the collection and document layer, but the current runtime implementation forwards raw transporter results without wrapping them

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