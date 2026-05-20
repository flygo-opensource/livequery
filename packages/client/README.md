# @livequery/client

Reactive local-first data primitives for browser clients.

`@livequery/client` is a client library, not an application framework. It gives you a small set of reusable primitives for local storage, remote transport, reactive collections, reactive documents, optimistic mutations, filtering, sorting, pagination cursors, and action triggers.

The package is ESM-first and currently targets browser clients. `LivequeryCollection.initialize()` returns early when `window` is unavailable, so do not treat the collection wrapper as SSR-safe state by default.

## Install

```bash
bun add @livequery/client rxjs
```

For React projects you may also use a React bridge package if your app has one:

```bash
bun add @livequery/client @livequery/react rxjs
```

## Public Exports

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

The public storage interface is intentionally named `LivequeryStorge`. The spelling is part of the current public API.

## Mental Model

```text
LivequeryCollection / LivequeryDocument
            |
            v
        LivequeryClient
        /          \
       v            v
LivequeryStorge  LivequeryTransporter(s)
```

- `LivequeryClient` is the coordination core. It owns collection registrations, query orchestration, transporter fan-out, local storage writes, broadcast delivery, and optimistic mutation reconciliation.
- `LivequeryCollection<T>` is the main consumer-facing list or document wrapper. It exposes reactive subjects such as `items`, `loading`, `filters`, `paging`, `summary`, and `error`.
- `LivequeryDocument<T>` wraps one document in a `BehaviorSubject` and forwards `update`, `del`, `trigger`, and `select` calls to its collection.
- `LivequeryStorge` is the local persistence contract used by the client.
- `LivequeryMemoryStorage` is the in-memory reference storage adapter.
- `LivequeryTransporter` is the remote sync/action contract.

## Refs

Livequery distinguishes collection refs and document refs by path segment count:

- Collection ref: odd number of path segments, for example `todos` or `users/user-1/posts`.
- Document ref: even number of path segments, for example `todos/todo-1` or `users/user-1/posts/post-1`.

`LivequeryCollection.initialize(ref)` derives `collection_ref` from this rule. For `todos/todo-1`, the collection ref is `todos` and the document id is `todo-1`.

## Quick Start

```ts
import {
  LivequeryClient,
  LivequeryCollection,
  LivequeryMemoryStorage,
  type DataChangeEvent,
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
  query(query) {
    const changes: DataChangeEvent[] = [
      {
        collection_ref: query.ref,
        id: "todo-1",
        type: "added",
        data: {
          id: "todo-1",
          title: "Read the docs",
          done: false,
          createdAt: Date.now(),
        },
      },
    ]

    return of<Partial<LivequeryQueryResult>>({
      changes,
      paging: { total: 1, current: 1 },
      summary: { open: 1 },
      metadata: {},
      source: "query",
    })
  },
  async add(_ref, doc) {
    return { id: crypto.randomUUID(), ...doc } as Todo
  },
  async update(_ref, id, patch) {
    return { id, ...patch } as Todo
  },
  async delete(_ref, id) {
    return { id } as Todo
  },
  async trigger(action) {
    return { ok: true, action: action.action }
  },
}

const client = new LivequeryClient({
  storage,
  transporters: {
    primary: transporter,
  },
})

const todos = new LivequeryCollection<Todo>(client, {
  mode: "cache-first",
  filters: {
    "createdAt:sort": "desc",
  },
})

todos.initialize("todos")

const subscription = todos.items.subscribe((items) => {
  console.log(items.map((item) => item.value))
})

await todos.query({
  ":limit": 20,
  "done:boolean": "false",
  "createdAt:sort": "desc",
})

await todos.add({
  title: "Ship feature",
  done: false,
  createdAt: Date.now(),
})

await todos.update({
  id: "todo-1",
  done: true,
})

await todos.delete("todo-1")

subscription.unsubscribe()
```

## Core Types

### `Doc`

Every document must have an `id`.

```ts
type Doc<T = {}> = T & {
  id: string
}
```

Use it to define app records:

```ts
type Post = Doc<{
  title: string
  published: boolean
  author: {
    id: string
    name: string
  }
}>
```

### `DocState`

`DocState<T>` is the runtime shape exposed by collections and documents. It includes your document fields plus internal optimistic metadata.

```ts
type DocState<T extends Doc> = T & {
  _deleting?: boolean
  _local_only?: boolean
  _deleting_error?: { code: string; message: string; transporter_id: string }
  _updating?: boolean
  _updating_error?: { code: string; message: string; transporter_id: string }
  _adding?: boolean
  _adding_error?: { code: string; message: string; transporter_id: string }
  _remotes?: Record<string, string | number>
  _prev?: Record<string, any>
  _selected?: boolean
  _index?: number
}
```

Do not strip `_adding`, `_updating`, `_deleting`, or error fields if your UI needs to show mutation progress or failure state.

### `DataChangeEvent`

Transporter query streams and internal broadcasts use incremental change events:

```ts
type DataChangeEvent = {
  collection_ref: string
  id: string
  type: "added" | "removed" | "modified"
  data?: Record<string, any>
}
```

Events are incremental, not full snapshot replacements. A `modified` event may contain only changed fields.

## `LivequeryClient`

`LivequeryClient` coordinates storage, transporters, query streams, optimistic writes, and collection broadcasts.

```ts
const client = new LivequeryClient({
  storage: new LivequeryMemoryStorage(),
  transporters: {
    primary: transporter,
  },
})
```

### Constructor

```ts
new LivequeryClient({
  storage,
  transporters,
})
```

- `storage`: a `LivequeryStorge` adapter.
- `transporters`: a map of transporter id to `LivequeryTransporter`. Use one transporter for a simple app. Use multiple transporters when the same client should fan out to more than one backend.

### `watch(ref, collection_id, mode)`

Registers a collection or document watcher and returns an observable data stream.

Most app code should not call `watch()` directly. `LivequeryCollection.initialize()` calls it for you. Use it only when building a custom wrapper around `LivequeryClient`.

### `query(req)`

Lower-level query entry point used by `LivequeryCollection.query()`.

```ts
await client.query<Todo>({
  ref: "todos",
  collection_id: todos.id,
  filters: { "done:boolean": "false" },
})
```

Consumers should usually call `collection.query(filters)` instead.

### `add(collection_ref, documents, mode)`

Lower-level mutation entry point used by `LivequeryCollection.add()`.

- `server-first`: push to transporters first.
- `local-first`: add to storage with `_adding: true`, broadcast locally, then push remote and reconcile.
- `local-only`: add to storage with `_adding: true` and `_local_only: true`, broadcast locally, and skip transporters.

### `update(collection_ref, documents, mode)`

Lower-level mutation entry point used by `LivequeryCollection.update()`.

For local-first style updates, the client reads the old local document, records previous field values in `_prev`, stores `_updating: true`, broadcasts a `modified` event, then pushes only changed fields to transporters.

### `delete(collection_ref, ids, mode)`

Lower-level delete entry point used by `LivequeryCollection.delete()`.

- Local-only documents and explicit `local-only` deletes are hard-deleted from storage.
- Documents with transporters are soft-deleted first with `_deleting: true`, then hard-deleted after remote confirmation.
- Remote delete errors are persisted as `_deleting_error`.

### `trigger(action)`

Calls transporter `trigger()` methods and returns an RxJS observable.

```ts
client.trigger<{ archived: boolean }>({
  ref: "todos",
  action: "archive-done",
  payload: { olderThan: Date.now() - 7 * 86400_000 },
  transporter_id: "primary",
})
```

Use `collection.trigger()` for normal consumer code.

### `flush(collection_ref)`

Broadcasts a wildcard local removal for a collection and clears storage.

```ts
await client.flush("todos")
```

This is broad because the current storage contract has `flush(): Promise<void>` without a collection argument.

### `destroy()`

Unsubscribes the client's internal query pipelines. Call it when permanently disposing a client instance.

## `LivequeryCollection`

`LivequeryCollection<T>` is the primary app-facing API. It manages one collection ref or one document ref and exposes reactive state through `BehaviorSubject`s.

```ts
const todos = new LivequeryCollection<Todo>(client, {
  mode: "local-first",
  lazy: false,
  debounce: 250,
  filters: {
    "done:boolean": "false",
    "createdAt:sort": "desc",
  },
})
```

### Options

```ts
type LivequeryCollectionOptions<T extends Doc> = {
  filters: Partial<LivequeryFilters<T>>
  lazy: boolean
  debounce: number
  mode: "server-first" | "cache-first" | "local-first" | "local-only"
}
```

- `filters`: initial query filters.
- `lazy`: when not `true`, `initialize()` schedules an automatic query with current filters.
- `debounce`: enables `debounceQuery()`.
- `mode`: controls query behavior. Mutation methods still default to `server-first` unless you pass a mode override.

### Reactive Properties

```ts
items: BehaviorSubject<LivequeryDocument<DocState<T>>[]>
summary: BehaviorSubject<Record<string, any>>
loading: BehaviorSubject<null | "all" | "next" | "prev">
filters: BehaviorSubject<Partial<LivequeryFilters<T>>>
paging: BehaviorSubject<LivequeryPaging>
selected: BehaviorSubject<Set<string>>
error: BehaviorSubject<{ code: string; message: string } | null>
ref: string | undefined
collection_ref: string | undefined
id: string
```

Reading `.value` gives a snapshot. Subscribe for live updates:

```ts
const sub = todos.items.subscribe((documents) => {
  for (const document of documents) {
    console.log(document.value.id, document.value.title)
  }
})

sub.unsubscribe()
```

### `initialize(ref)`

Initializes the collection and registers it with the client.

```ts
todos.initialize("todos")
```

Call `initialize()` before `query()`, `add()`, `update()`, `delete()`, `trigger()`, or `flush()`. The method returns a subscription when running in the browser. It returns early on the server.

### `query(filters)`

Runs a query and replaces current `items` when cached/local documents are returned.

```ts
await todos.query({
  ":limit": 20,
  "done:boolean": "false",
  "createdAt:sort": "desc",
})
```

### `debounceQuery(filters)`

Pushes filters into a debounced query subject. This only has an effect when the collection was created with a truthy `debounce` option.

```ts
const searchTodos = new LivequeryCollection<Todo>(client, {
  mode: "cache-first",
  debounce: 300,
})

searchTodos.initialize("todos")
await searchTodos.debounceQuery({ "title:like": "milk" })
```

### `sort(field, order)`

Sorts by a field or resets to insertion order.

```ts
await todos.sort("createdAt", "desc")
await todos.sort("title", "asc")
await todos.sort("reset", "asc")
```

For non-`local-only` collections, sorting calls `query()` with a `field:sort` filter. For `local-only`, sorting is applied to current items in memory.

### `loadMore()`, `loadPrev()`, `loadAround(cursor)`

Cursor helpers based on `paging.value`.

```ts
if (todos.paging.value.next) {
  await todos.loadMore()
}

if (todos.paging.value.prev) {
  await todos.loadPrev()
}

await todos.loadAround("cursor-123")
```

- `loadMore()` adds `:after`.
- `loadPrev()` adds `:before`.
- `loadAround(cursor)` currently sets both `:after` and `:before` to the same cursor.

### `add(payload, mode?)`

Adds one or many documents.

```ts
const todo = await todos.add({
  title: "Buy milk",
  done: false,
  createdAt: Date.now(),
})

const localDraft = await todos.add(
  { title: "Draft", done: false, createdAt: Date.now() },
  "local-only"
)

const many = await todos.add([
  { title: "A", done: false, createdAt: Date.now() },
  { title: "B", done: false, createdAt: Date.now() },
])
```

The return shape follows the input shape: one payload returns one document; an array returns an array.

Important: the current method signature defaults `mode` to `"server-first"`. A collection configured with `mode: "local-only"` still needs `add(payload, "local-only")` if you want the mutation to stay local.

### `update(payload, mode?)`

Updates one or many documents. Include `id` in every payload.

```ts
await todos.update({
  id: "todo-1",
  done: true,
})

await todos.update(
  { id: "todo-1", title: "Local title" },
  "local-only"
)

await todos.update([
  { id: "todo-1", done: true },
  { id: "todo-2", done: false },
])
```

### `delete(idOrIds, mode?)`

Deletes one or many documents.

```ts
await todos.delete("todo-1")
await todos.delete(["todo-1", "todo-2"])
await todos.delete("todo-draft", "local-only")
```

### `select(mode, id?)`

Maintains `selected` state and writes `_selected` back into documents with local-only updates.

```ts
todos.select("all")
todos.select("none")
todos.select("toggle")
todos.select("toggle", "todo-1")
todos.select(true, "todo-1")
todos.select(false, "todo-1")
```

### `trigger(action, payload?, transporter_id?)`

Calls transporter actions for this collection ref.

```ts
const result = await todos.trigger<{ count: number }>("archive-done", {
  olderThan: Date.now() - 7 * 86400_000,
})

todos.trigger("refresh-index").subscribe((value) => {
  console.log(value)
})
```

The returned value is an observable with a Promise-like `then()` method.

### `resetError()`

Clears the collection error subject.

```ts
todos.resetError()
```

### `watch(check)`

Watches pairwise document changes and emits when `check(prev, next)` returns `true`.

```ts
const doneSub = todos.watch((prev, next) => prev.done !== next.done).subscribe(([prev, next]) => {
  console.log(prev.id, "done changed", prev.done, "=>", next.done)
})

doneSub.unsubscribe()
```

### `flush()`

Flushes storage through the client for this collection's `collection_ref`.

```ts
await todos.flush()
```

## `LivequeryDocument`

Every item in `collection.items.value` is a `LivequeryDocument<T>`. It extends `BehaviorSubject<DocState<T>>`.

```ts
const first = todos.items.value[0]

first.subscribe((value) => {
  console.log(value.title, value._updating)
})
```

### `update(data, mode?)`

Updates the current document through its collection. The document id is added automatically.

```ts
await first.update({ done: true })
await first.update({ title: "Local edit" }, "local-only")
```

### `del(mode?)`

Deletes the current document through its collection.

```ts
await first.del()
await first.del("local-only")
```

### `trigger(action, payload?)`

Calls a collection trigger using the document's collection ref.

```ts
await first.trigger("archive", { reason: "completed" })
```

### `select(selected)`

Forwards selection changes to the parent collection.

```ts
first.select("toggle")
first.select(true)
first.select(false)
```

## `LivequeryStorge`

Storage adapters provide local persistence and local filtering.

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
  add<T extends Doc>(collection: string, document: Partial<DocState<T>>): Promise<DocState<T>>
  update<T extends Doc>(collection: string, id: string, document: Record<string, any>): Promise<DocState<T> | null>
  delete<T extends Doc>(collection: string, id: string): Promise<DocState<T> | null>
  flush(): Promise<void>
}
```

Adapter guidance:

- `query()` should apply the same filter semantics as `filterDocs()` when possible.
- `get()` must return the full local document because local broadcast filtering reads it for `modified` events.
- `add()` should generate an id when one is missing.
- `update()` should merge patch fields into the stored document.
- `delete()` should return the deleted document or `null`.
- `flush()` currently clears all storage.

## `LivequeryMemoryStorage`

The built-in in-memory adapter is useful for demos, tests, and ephemeral browser state.

```ts
const storage = new LivequeryMemoryStorage()

await storage.add<Todo>("todos", {
  title: "Local only",
  done: false,
  createdAt: Date.now(),
})

const page = await storage.query<Todo>("todos", {
  "done:boolean": "false",
  "createdAt:sort": "desc",
})
```

It stores documents in a `Map<string, Map<string, Doc>>`, generates ids with `uuidv7`, applies runtime filtering through `filterDocs()`, and supports nested path sorting such as `"author.profile.createdAt:sort"`.

## `LivequeryTransporter`

Transporters connect the client to remote systems.

```ts
type LivequeryTransporter = {
  query<T extends Doc>(query: LivequeryQueryParams<T>): Observable<Partial<LivequeryQueryResult>>
  add<T extends Doc>(ref: string, doc: Omit<T, "id">): Promise<T>
  update<T extends Doc>(ref: string, id: string, doc: Partial<T>): Promise<T>
  delete<T extends Doc>(ref: string, id: string): Promise<T>
  trigger<T>(action: LivequeryAction): Promise<T>
}
```

### Query Streams

`query()` returns an observable because transporters can emit:

- initial query changes
- pagination updates
- summary updates
- later realtime changes

```ts
import { Observable } from "rxjs"

const apiTransporter: LivequeryTransporter = {
  query(query) {
    return new Observable((subscriber) => {
      fetch(`/api/${query.ref}`)
        .then((res) => res.json())
        .then((documents: Todo[]) => {
          subscriber.next({
            changes: documents.map((doc) => ({
              collection_ref: query.ref,
              id: doc.id,
              type: "added",
              data: doc,
            })),
            paging: {
              total: documents.length,
              current: documents.length,
            },
            source: "query",
          })
        })
        .catch((error) => {
          subscriber.next({
            error: {
              code: "QUERY_FAILED",
              message: String(error),
            },
            source: "query",
          })
        })
    })
  },
  async add(ref, doc) {
    const res = await fetch(`/api/${ref}`, {
      method: "POST",
      body: JSON.stringify(doc),
      headers: { "content-type": "application/json" },
    })
    return res.json()
  },
  async update(ref, id, patch) {
    const res = await fetch(`/api/${ref}/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
      headers: { "content-type": "application/json" },
    })
    return res.json()
  },
  async delete(ref, id) {
    const res = await fetch(`/api/${ref}/${id}`, {
      method: "DELETE",
    })
    return res.json()
  },
  async trigger(action) {
    const res = await fetch(`/api/${action.ref}:trigger`, {
      method: "POST",
      body: JSON.stringify(action),
      headers: { "content-type": "application/json" },
    })
    return res.json()
  },
}
```

## Query Modes

### `server-first`

Transporters drive the query result. Collection state is built from streamed change events.

Use it when remote data is the source of truth and local cache is secondary.

### `cache-first`

The first query can hydrate from storage, then transporters refresh in the background.

Use it when fast initial UI matters but remote sync should still run.

### `local-first`

Storage serves the query immediately. Transporters refresh in the background. Remote query changes are written into storage and then broadcast back into matching local collections.

For `local-first`, the remote query path receives empty filters. Local filtering is enforced by storage query results and by broadcast filtering.

### `local-only`

Queries resolve only from storage and skip transporters. Mutations stay local only when you explicitly call them with `mode: "local-only"`.

Use it for drafts, temporary UI state, offline-only collections, or local workspaces.

```ts
const drafts = new LivequeryCollection<Todo>(client, {
  mode: "local-only",
})

drafts.initialize("drafts")

await drafts.add(
  { title: "Unpublished draft", done: false, createdAt: Date.now() },
  "local-only"
)
```

## Broadcast Filtering

For `local-first` and `local-only` collection watchers, `LivequeryClient` filters broadcast events against the collection's current filters before delivering them:

- `added`: forwarded only when `event.data` matches filters.
- `modified`: reads the full document from storage and forwards `modified` only if the full document still matches filters.
- `modified` that no longer matches filters is converted to `removed` for that collection.
- `removed`: forwarded without filter checks.

Within one broadcast call, full-document reads are cached by `collection_ref/id` so multiple local collections do not repeatedly call storage for the same modified document.

Current limitation: if a document was not already present in a filtered collection and a later `modified` event makes it match, the client does not yet convert that `modified` into `added`. A later query will include it.

## Filters

Filters are flat object keys derived from document fields.

### Pagination Keys

- `:limit`
- `:before`
- `:after`
- `:around`
- `:page`

### Operators

- `field`: strict equality
- `field:sort`: `"asc" | "desc"`
- `field:gt`, `field:gte`, `field:lt`, `field:lte`: numeric comparisons
- `field:eq-number`: numeric equality after `Number(value)`
- `field:in`, `field:nin`: membership for string or number values
- `field:include`: array contains value
- `field:boolean`: `"true" | "false" | "not-true" | "not-false"`
- `field:like`: case-insensitive substring check
- `field:null`: `"null-only" | "not-null"`

Nested field paths are supported:

```ts
await posts.query({
  "author.id": "user-1",
  "stats.views:gte": 100,
  "published:boolean": "true",
  "title:like": "livequery",
  "createdAt:sort": "desc",
})
```

## Helper Functions

### `filterDocs(documents, filters)`

Filters an array with the same runtime semantics used by `LivequeryMemoryStorage`.

```ts
import { filterDocs } from "@livequery/client"

const openTodos = filterDocs(todos, {
  "done:boolean": "false",
})
```

### `matchesAllFilters(doc, filters)`

Predicate helper for checking one document.

```ts
import { matchesAllFilters } from "@livequery/client"

if (matchesAllFilters(todo, { "done:boolean": "false" })) {
  console.log("todo is open")
}
```

## React Usage

Bridge `BehaviorSubject` values into React state.

```tsx
import { useEffect, useMemo, useState } from "react"
import { LivequeryCollection, type DocState } from "@livequery/client"

function TodoList({ collection }: { collection: LivequeryCollection<Todo> }) {
  const [items, setItems] = useState(() => collection.items.value)
  const [loading, setLoading] = useState(() => collection.loading.value)

  useEffect(() => {
    const sub = collection.items.subscribe(setItems)
    const loadingSub = collection.loading.subscribe(setLoading)
    return () => {
      sub.unsubscribe()
      loadingSub.unsubscribe()
    }
  }, [collection])

  return (
    <ul aria-busy={loading !== null}>
      {items.map((item) => (
        <li key={item.value.id}>
          <label>
            <input
              type="checkbox"
              checked={item.value.done}
              onChange={() => item.update({ done: !item.value.done })}
            />
            {item.value.title}
            {item.value._updating ? " Saving..." : null}
          </label>
        </li>
      ))}
    </ul>
  )
}
```

Do not read `collection.items.value` once during render and expect the UI to stay in sync. Subscribe or use a framework-specific adapter.

## Common Usage Patterns

### App-Level Client

Create one shared client per data boundary.

```ts
export const livequery = new LivequeryClient({
  storage: new LivequeryMemoryStorage(),
  transporters: {
    primary: apiTransporter,
  },
})
```

### Collection Factory

```ts
export function createTodoCollection() {
  const collection = new LivequeryCollection<Todo>(livequery, {
    mode: "cache-first",
    filters: {
      "createdAt:sort": "desc",
    },
  })
  collection.initialize("todos")
  return collection
}
```

### Document Ref

```ts
const todo = new LivequeryCollection<Todo>(client, {
  mode: "cache-first",
})

todo.initialize("todos/todo-1")
await todo.query({})
```

A document ref still exposes `items`; the matching document is represented as a one-item collection.

## Caveats

- `LivequeryCollection.initialize()` is browser-only in the current implementation.
- Mutations default to `server-first` because the method parameter has that default. Pass `"local-first"` or `"local-only"` explicitly when needed.
- `LivequeryCollection` has no initialized `metadata` subject in the current constructor, so transporter `metadata` should not be considered reliable consumer state yet.
- `trigger()` returns an observable with a Promise-like `then()` method.
- Transporter streams should emit incremental changes. Do not send full snapshots as repeated `added` events unless the client can safely deduplicate by id.
- There is no dedicated test suite in this package yet. Use `bun run build` for the current validation baseline.

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
- `bun run prepublishOnly`
