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
export * from "./LivequeryIndexedDBStorage"
export * from "./LivequeryOutbox"
export * from "./LivequeryStorage"
export * from "./LivequeryStorge"
export * from "./LivequeryTransporter"
export * from "./types"
export * from "./helpers/filterDocs"
export * from "./LivequeryDocument"
```

`@livequery/client/testing` is a separate entry point with `defineStorageConformanceSuite` for storage adapter authors (see [Writing a storage adapter](#writing-a-storage-adapter)); it is not part of the main bundle.

The public storage interface is `LivequeryStorage`. The previous misspelled name `LivequeryStorge` remains exported as a backward-compatible alias.

## Mental Model

```text
LivequeryCollection / LivequeryDocument
            |
            v
        LivequeryClient
        /          \
       v            v
LivequeryStorage LivequeryTransporter(s)
```

- `LivequeryClient` is the coordination core. It owns collection registrations, query orchestration, transporter fan-out, local storage writes, broadcast delivery, and optimistic mutation reconciliation.
- `LivequeryCollection<T>` is the main consumer-facing list or document wrapper. It exposes reactive subjects such as `items`, `loading`, `filters`, `paging`, `summary`, and `error`.
- `LivequeryDocument<T>` wraps one document in a `BehaviorSubject` and forwards `update`, `del`, `trigger`, and `select` calls to its collection.
- `LivequeryStorage` is the local persistence contract used by the client. `LivequeryStorge` is a backward-compatible alias.
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
  "done:eq-boolean": "false",
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
  _queued?: boolean
  _remotes?: Record<string, string | number>
  _prev?: Record<string, any>
  _selected?: boolean
  _index?: number
}
```

Do not strip `_adding`, `_updating`, `_deleting`, or error fields if your UI needs to show mutation progress or failure state.

Field reference:

| Field | Set when | Meaning |
|---|---|---|
| `_adding` | `local-first` / `local-only` add in progress | Document is being created on the server |
| `_adding_error` | Server add rejected | Error from the failed transporter call |
| `_updating` | `local-first` update in progress | Document is being synced to the server |
| `_updating_error` | Server update rejected | Error from the failed transporter call |
| `_deleting` | `local-first` delete in progress | Document is pending deletion on the server |
| `_deleting_error` | Server delete rejected | Error from the failed transporter call |
| `_queued` | `local-first` write stuck behind a network failure | The write sits in the outbox and will be retried; see [Offline-first](#offline-first) |
| `_local_only` | `local-only` add | Document was created locally and never sent to the server |
| `_prev` | `local-first` update pending | Values from BEFORE the first unconfirmed edit of each field. Its keys are the fields to push, and while it is set those fields keep their local value against remote changes |
| `_selected` | `select()` called | Whether the document is currently selected |
| `_index` | Assigned on insert | Stable insertion order used for sort reset |
| `_remotes` | Transporter-specific | Optional metadata from transporters; not used by the client core |

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

- `storage`: a `LivequeryStorage` adapter.
- `transporters`: a map of transporter id to `LivequeryTransporter`. Use one transporter for a simple app. Use multiple transporters when the same client should fan out to more than one backend.
- `conflictResolver` (optional): decides what happens when a remote change reaches a document with unconfirmed local edits. See [Conflicts](#conflicts).

The client starts its outbox on construction, so writes queued by an earlier session (a reload, a killed service worker) are sent without anything else to call.

### `outbox`

The client's `LivequeryOutbox`. Useful members:

- `pending()`: the queued writes, oldest first.
- `pending$`: the same list as an observable, for a sync indicator:

  ```ts
  client.outbox.pending$.subscribe(entries => setBadge(entries.length ? `${entries.length} unsynced` : ""))
  ```

- `trigger()`: retry now instead of waiting for the backoff — e.g. from a "retry" button, or after refreshing an expired token.

### `refetch()`

Re-runs the last first-page query of every live collection and reconciles the result with what is on screen. The client calls it by itself when a transporter reconnects; call it yourself if your app has a better signal (a tab regaining focus after hours, say).

### `watch(ref, collection_id, mode)`

Registers a collection or document watcher and returns an observable data stream.

Most app code should not call `watch()` directly. `LivequeryCollection.initialize()` calls it for you. Use it only when building a custom wrapper around `LivequeryClient`.

### `query(req)`

Lower-level query entry point used by `LivequeryCollection.query()`.

```ts
await client.query<Todo>({
  ref: "todos",
  collection_id: todos.id,
  filters: { "done:eq-boolean": "false" },
})
```

Consumers should usually call `collection.query(filters)` instead.

### `add(collection_ref, documents, mode)`

Lower-level mutation entry point used by `LivequeryCollection.add()`.

- `server-first`: push to transporters first; throws on failure.
- `local-first`: add to storage with `_adding: true`, broadcast locally, then hand the write to the outbox. Resolves with the server's document, or with the local document (`_queued: true`) when the network is down.
- `local-only`: add to storage with `_adding: true` and `_local_only: true`, broadcast locally, and skip transporters.

### `update(collection_ref, documents, mode)`

Lower-level mutation entry point used by `LivequeryCollection.update()`.

For local-first style updates, the client reads the old local document, records previous field values in `_prev`, stores `_updating: true`, broadcasts a `modified` event, then hands the write to the outbox, which pushes only the fields in `_prev`.

### `delete(collection_ref, ids, mode)`

Lower-level delete entry point used by `LivequeryCollection.delete()`.

- Local-only documents and explicit `local-only` deletes are hard-deleted from storage.
- Documents with transporters are soft-deleted first with `_deleting: true`, then hard-deleted after remote confirmation.
- Remote delete errors are persisted as `_deleting_error`. A delete the server answers with 404 counts as done.

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

This is broad because the current storage contract has `flush(): Promise<void>` without a collection argument. It also empties the outbox: writes that never reached the server are dropped, and the client logs a warning when there were any.

### `destroy()`

Unsubscribes the client's internal query pipelines and stops the outbox. Queued writes stay in storage for the next client on the same storage. Call it when permanently disposing a client instance.

## `LivequeryCollection`

`LivequeryCollection<T>` is the primary app-facing API. It manages one collection ref or one document ref and exposes reactive state through `BehaviorSubject`s.

```ts
const todos = new LivequeryCollection<Todo>(client, {
  mode: "local-first",
  lazy: false,
  debounce: 250,
  filters: {
    "done:eq-boolean": "false",
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
  seed: {
    data: T[]
    persist: boolean
  }
  context: Record<string, any>
}
```

- `filters`: initial query filters.
- `lazy`: when not `true`, `initialize()` schedules an automatic query with current filters.
- `debounce`: enables `debounceQuery()`.
- `mode`: controls query behavior. Mutation methods still default to `server-first` unless you pass a mode override.
- `seed`: optional initial data. `seed.data` is an array of documents loaded into `items` before any query runs. `seed.persist: false` populates items in memory only — storage is not written. `seed.persist: true` writes the seed to storage before the first query, so a `cache-first` or `local-first` query can read from it immediately.
- `context`: an arbitrary bag forwarded with **every** operation of this collection (query, add, update, delete, trigger) down to the transporter. It is **not** sent to the server by default — the transporter decides what to do with it (e.g. inject a header). See [context](#context).

### `seed`

Pre-populate a collection with data before any query runs. Useful for hardcoded defaults, SSR-hydrated data, or offline stubs.

```ts
const todos = new LivequeryCollection<Todo>(client, {
  mode: "cache-first",
  seed: {
    data: [
      { id: "1", title: "Buy milk", done: false, createdAt: Date.now() },
    ],
    persist: true,
  },
})

todos.initialize("todos")
// items.value already has the seeded document before the first query
```

`persist: false` — items are loaded into `items` immediately in the constructor. Storage is never written. The seed disappears after a query replaces items.

`persist: true` — seed data is written to storage before the first auto-query runs. This lets a `cache-first` query read the seed from storage on the first render.

Rules:

- Seed documents must include `id`.
- When `persist: true` and `lazy: false`, the client calls `seedToStorage()` then starts the auto-query. The auto-query may overwrite seed items when the transporter responds.
- When `persist: false`, seed items are available immediately in `items.value` from the constructor but are replaced on the first `query()` call.
- `seed` has no effect on the mode behavior. The collection still uses the configured mode for queries.

### context

`context` is an arbitrary per-collection bag attached to every operation and threaded down to the transporter:

```ts
const todos = new LivequeryCollection<Todo>(client, {
  mode: "server-first",
  context: { account_id: "acc-42" },
})

todos.initialize("todos")
```

How it flows:

- `query()` carries `context` on `LivequeryQueryParams.context` → `transporter.query({ ..., context })`.
- `add()` / `update()` / `delete()` pass it as the trailing `context?` argument → `transporter.add/update/delete(ref, ..., context)`.
- `trigger()` carries it on `LivequeryAction.context` → `transporter.trigger({ ..., context })`.

The client core never inspects `context`; it only forwards it. A transporter chooses how to apply it — for example the `@livequery/rest` transporter exposes it on its `onRequest` hook so you can turn `{ account_id }` into a request header for per-tab multi-account routing.

Because `context` lives on the collection options, switching context means a new query subscription under the new context. With the React bridge, `useCollection` keys the collection on the context so changing it (e.g. switching account) tears down the old subscription and re-subscribes — see `@livequery/react`.

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
  "done:eq-boolean": "false",
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
- `loadAround(cursor)` loads a page centered on the given cursor. It sets both `:after` and `:before` to the same cursor value — the backend decides what "around a cursor" means for that collection.

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

The default mutation mode follows `#defaultMode()`:

| Collection `mode` | Mutation default |
|---|---|
| `server-first` | `server-first` |
| `cache-first` | `server-first` |
| `local-first` | `local-first` |
| `local-only` | `local-only` |
| not set | `server-first` |

```ts
// local-only collection — mutations also default to local-only
const drafts = new LivequeryCollection<Todo>(client, { mode: "local-only" })
drafts.initialize("drafts")
await drafts.add({ title: "Draft", done: false, createdAt: Date.now() })
// ✓ stored locally, no server call

// local-first collection — optimistic local write + background server sync
const notes = new LivequeryCollection<Todo>(client, { mode: "local-first" })
notes.initialize("notes")
await notes.add({ title: "Note", done: false, createdAt: Date.now() })
// ✓ appears immediately, syncs to server in background

// cache-first collection — mutations go server-first by default
const posts = new LivequeryCollection<Post>(client, { mode: "cache-first" })
posts.initialize("posts")
await posts.add({ title: "Post", done: false, createdAt: Date.now() })
// ✓ blocks until server responds (server-first default)
```

Pass an explicit mode to override the default on a per-call basis:

```ts
await drafts.add({ title: "Force server", done: false, createdAt: Date.now() }, "server-first")
await posts.add({ title: "Local draft", done: false, createdAt: Date.now() }, "local-only")
```

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

Returns `Observable<[DocState<T>, DocState<T>]>` — each emission is a `[previous, current]` pair for the document that changed.

```ts
// Watch when the `done` field changes on any todo
const doneSub = todos.watch((prev, next) => prev.done !== next.done)
  .subscribe(([prev, next]) => {
    console.log(next.id, "done changed:", prev.done, "→", next.done)
  })

doneSub.unsubscribe()

// Watch when any field changes
const anySub = todos.watch((prev, next) => prev !== next).subscribe(([prev, next]) => {
  console.log("document changed:", next.id)
})

// Watch for optimistic mutation completion
const saveSub = todos.watch(
  (prev, next) => prev._updating === true && next._updating == null
).subscribe(([, next]) => {
  console.log("save confirmed for:", next.id)
})
```

`check` is called for every field emission of every document in `items`. Keep it fast. Avoid closures that capture large objects.

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

## `LivequeryStorage`

Storage adapters provide local persistence and local filtering.

```ts
type LivequeryStorage = {
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
  readonly shared?: string
}
```

`LivequeryStorge` is still exported as an alias for existing consumers.

Adapter guidance:

- `query()` should apply the same filter semantics as `filterDocs()` when possible.
- `get()` must return the full local document because local broadcast filtering reads it for `modified` events.
- `add()` should generate an id when one is missing.
- `update()` should merge patch fields into the stored document.
- `delete()` should return the deleted document or `null`.
- `flush()` currently clears all storage.
- `shared` is for adapters whose data several contexts see at once (IndexedDB is shared by every tab of an origin). Contexts with the same value elect one outbox drainer through `navigator.locks`, so a queued write is not sent twice.

### Writing a storage adapter

`@livequery/client/testing` exports the contract every adapter must pass. The outbox, the conflict rebase and the id remap call nothing but the six storage methods, so an adapter that passes the suite can back an offline-first client:

```ts
import { describe, test, expect } from "bun:test" // or vitest / jest
import { defineStorageConformanceSuite } from "@livequery/client/testing"

defineStorageConformanceSuite({
  name: "MyStorage",
  create: () => new MyStorage(),
  dispose: (storage) => storage.close(),
  describe,
  test,
  expect,
})
```

It pins: `add` keeps a given id and assigns a `local:` id otherwise; `update` with a different `id` moves the document; documents round-trip as plain JSON; `query()` answers exactly like `filterDocs()`, with paging totals; collections are isolated; `flush()` empties everything.

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
  "done:eq-boolean": "false",
  "createdAt:sort": "desc",
})
```

It stores documents in a `Map<string, Map<string, Doc>>`, generates ids with `uuidv7`, applies runtime filtering through `filterDocs()`, and supports nested path sorting such as `"author.profile.createdAt:sort"`.

Everything in it — cache, pending flags, queued writes — is gone on reload. Use `LivequeryIndexedDBStorage` for an offline-first web app.

## `LivequeryIndexedDBStorage`

A `LivequeryStorage` on IndexedDB, with no runtime dependency. Data, pending flags and the outbox survive reloads and browser restarts.

```ts
import { LivequeryClient, LivequeryIndexedDBStorage } from "@livequery/client"

const client = new LivequeryClient({
  storage: new LivequeryIndexedDBStorage({ name: "my-app", persist: true }),
  transporters: { rest },
})
```

Options:

- `name`: database name, default `livequery`. Two storages with the same name share their data.
- `persist`: call `navigator.storage.persist()` to ask the browser not to evict the origin. Recommended for offline-first apps.
- `indexedDB`: an `IDBFactory` to use instead of the global one (tests, embedded runtimes).
- `keyRange`: the `IDBKeyRange` that goes with it, when it is not the global one.
- `indexAfter`: a collection at least this large (default 500) gets an index on the field it is sorted by.

One object store holds every collection under the key `[collection, id]` — IndexedDB can only create stores during a version upgrade, and collection refs are only known at runtime.

`query()` answers a plain page — `:limit`, `:after` or `:before`, one `field:sort` (or none: newest id first), nothing else — from an index and reads only that page: 0.6ms instead of 84ms for a page of 30 out of 20,000 messages in Chrome. The index is created the first time a collection that large is paged by that field (a version upgrade; other tabs reconnect on their own). Every other query loads the collection and runs `queryDocs()`, exactly like the memory storage. Both put documents in the same order; a document without the sort field comes first in `asc`, last in `desc`. Strings compare by code unit, as on the server; a field holding numbers in some documents and strings in others orders numbers first.

Counts of a page read from an index: `total` is exact (each collection's count is kept on every write), whether a next / previous page exists is exact, and `next.count` / `prev.count` follow from the position each cursor carries — off only if documents were added or removed before the page between two reads. Each index costs a little on every write. An id change (a server that assigned its own id to a new document) is read, re-keyed and written in one transaction. Where `indexedDB` does not exist (SSR, Node, Bun) it falls back to memory. `close()` closes the connection.

## `LivequeryTransporter`

Transporters connect the client to remote systems.

```ts
type LivequeryTransporter = {
  query<T extends Doc>(query: LivequeryQueryParams<T>): Observable<Partial<LivequeryQueryResult>>
  add<T extends Doc>(ref: string, doc: Omit<T, "id">, context?: Record<string, any>): Promise<T>
  update<T extends Doc>(ref: string, id: string, doc: Partial<T>, context?: Record<string, any>): Promise<T>
  delete<T extends Doc>(ref: string, id: string, context?: Record<string, any>): Promise<T>
  trigger<T>(action: LivequeryAction): Promise<T>
  status$?: Observable<{ connected: boolean }>
}
```

`status$` is optional, for transporters that hold a connection. When it turns `connected` the client retries queued writes; when it turns connected AGAIN after a drop, the client refetches live queries, because realtime events sent while the connection was down are lost. `RestTransporter` exposes its WebSocket state here when `ws` is configured.

The optional trailing `context` on `add`/`update`/`delete` (and `LivequeryQueryParams.context` / `LivequeryAction.context` for `query`/`trigger`) is the collection's [`context`](#context) option. Transporters that don't need it can ignore the argument.

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

> For detailed data flow diagrams, mutation behavior per mode, and common mistakes, see [docs/modes.md](./docs/modes.md).

| Mode | Query reads from | Transporter called? | Mutation default |
|------|------|------|------|
| `server-first` | Transporter | Yes, always | `server-first` |
| `cache-first` | Storage first, then transporter | Yes, in background | `server-first` |
| `local-first` | Storage immediately | Yes, full sync in background | `local-first` |
| `local-only` | Storage only | No | `local-only` |

### `server-first`

Transporters drive the query result. Collection state is built from streamed change events. Items are delivered asynchronously through the watch stream, not from the `query()` return value.

Use it when remote data is the source of truth and local cache is secondary.

### `cache-first`

The first query hydrates from local storage instantly, then transporters refresh in the background. For pagination queries (`:before` / `:after`), cache is skipped and the transporter is called directly. Mutations default to `server-first`.

Use it when fast initial UI matters but remote sync should still run.

### `local-first`

Storage serves the query immediately. The transporter syncs the full collection in the background by paginating all pages and writing results to storage. Remote changes are rebroadcast to local collections filtered by their current filters.

The server receives **empty filters** — local filtering happens during broadcast, not on the server.

Avoid this mode for large unbounded datasets; it attempts to sync every document locally.

### `local-only`

Queries resolve only from storage. Transporters are never called. No loading state is emitted. Mutations stay local when explicitly called with `mode: "local-only"`.

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

## Offline-first

With `local-first` collections and a persistent storage, the client keeps working without a network: reads come from storage, writes apply locally at once and wait in a durable outbox until they reach the server.

### What each mode does offline

| Mode | Reads offline | Writes offline |
|---|---|---|
| `server-first` | Nothing new; the query errors | **Throws** (`NETWORK_ERROR`). By design: a resolved server-first write means the server has it |
| `cache-first` | First page from storage, then the query errors | Mutations default to `server-first`: they throw |
| `local-first` | From storage | Applied locally, queued, sent when the network is back |
| `local-only` | From storage | Local only, never sent |

An offline-first app uses `local-first` collections (their mutations default to `local-first`) and passes `"server-first"` explicitly on the rare write that must be confirmed before continuing.

### Choosing a storage

| Environment | Storage | Notes |
|---|---|---|
| Chrome / Edge / Firefox | `LivequeryIndexedDBStorage` | Pass `persist: true` |
| Android Chrome, PWA | `LivequeryIndexedDBStorage` | No SharedWorker: every tab runs its own client, `navigator.locks` elects one outbox drainer |
| iOS Safari, PWA | `LivequeryIndexedDBStorage` | **Weakest**: Safari evicts origins unused for ~7 days, queued writes included. Installed PWAs fare better. Treat storage as a cache that can disappear |
| Chrome extension (MV3) | `LivequeryIndexedDBStorage` in the service worker | The worker is killed after ~30s idle; the outbox resumes from storage on the next start |
| Capacitor / Cordova WebView | `LivequeryIndexedDBStorage` | The OS may clear WebView data; a native SQLite adapter would be sturdier |
| React Native | a native adapter (MMKV, SQLite) | Not shipped yet; any adapter passing the [conformance suite](#writing-a-storage-adapter) works |
| Node / Bun / SSR | `LivequeryMemoryStorage` | `LivequeryIndexedDBStorage` falls back to memory by itself |

### The outbox

`client.outbox` is a FIFO queue of writes, persisted through the storage under the reserved ref `__livequery_outbox` — as durable as the storage you chose. Collections cannot watch that ref.

- **Every** `local-first` write goes through it. Online that is invisible: the write is sent at once and the mutation resolves with the server's answer.
- A retryable failure — network error, timeout, HTTP 5xx, 401, 408 or 429 — keeps the entry, marks the document `_queued: true` and resolves the mutation with the local document. Order is strict and one write is in flight at a time, so a failure stalls the queue behind it.
- **401 is retryable on purpose.** A write queued offline is often replayed hours later, after the login expired; dropping it would lose the user's work. The queue waits; refresh the token (the transporter reads it at send time, e.g. in `RestTransporter`'s `onRequest`) and call `client.outbox.trigger()`.
- Any other 4xx (validation, permission, not found) is the request's own fault: it is not queued, and the error lands on the document (`_adding_error`, `_updating_error`, `_deleting_error`) as before.
- If the queue itself cannot be written (storage quota, a closed database), the document gets an `_adding_error` / `_updating_error` / `_deleting_error` with code `OUTBOX_WRITE_FAILED` instead of the write silently not being durable.
- Retries back off from 2s to 30s. They also run at once when the client starts (resuming a previous session), on the global `online` event, when a transporter's `status$` turns connected, and on `client.outbox.trigger()`.
- Entries carry no payload. An add sends the stored document and an update sends the fields in `_prev`, read when the entry is sent — so queued writes to one document fold together: add + update is one add with the latest fields, add + delete sends nothing, update + update is one update, update + delete is only the delete.
- **Ids are chosen on the device.** `add()` gives every new document a uuidv7 and sends it; the 3.0 datasources (MongoDB, D1, Postgres) keep it as the document's id. So the id is final from the first moment: nothing is renamed after sync, and a document created offline can already be referenced by another one (`parent_id: parent.id`).
- **A retried add cannot duplicate.** If the first attempt reached the server but its answer was lost, the retry reuses the id and the server answers 409 `ID_ALREADY_EXISTS`. On a retry the client reads that as "already created" and sends what was edited since as an update. A 409 on the first attempt is a real conflict and lands on the document as `_adding_error`.
- A server that ignores the client id (before 3.0, or `clientIds: false` on the route) still works: when an add is confirmed under a different id, the client renames the document — in storage, on screen, and in every queued entry still pointing at it.
- This changes what `local-first` users saw before: `_adding`, `_updating` and `_prev` now stay set until the write is actually confirmed, instead of turning into an error flag on the first network failure.

### Conflicts

When a remote change (a query result or a realtime event) reaches a document with unconfirmed local edits, the client rebases it before storage or any collection sees it:

- Each field in `_prev` keeps its local value until its write is confirmed; every other field takes the remote value. The stored copy is rebased too.
- A pending delete ignores remote `modified` events: the user already chose to delete.
- A remote `removed` wins over a pending edit: the server no longer has the document.

Once the write is confirmed `_prev` clears and remote changes win again. The rebase works per field: if two people edit the same field, the one whose write reaches the server last wins that field. Merging inside a field (text, lists) is CRDT territory and out of scope.

To decide yourself, pass `conflictResolver`:

```ts
const client = new LivequeryClient({
  storage,
  transporters: { rest },
  conflictResolver: ({ from, old_document, change }) => ({
    approved: true, // false drops the remote change
    document: { ...old_document, ...change.data },
  }),
})
```

It is only called for documents with unconfirmed edits (`_prev`) or a pending delete. `from` is `{ transporter_id }`; the returned `document` is written to storage and delivered to collections.

### Reconnecting

A realtime event sent while the socket was down never arrives. When a transporter's `status$` reconnects, the client:

- re-runs the last first-page query of every `server-first` / `cache-first` collection, without a loading spinner;
- catches every active local-first scope up: a delta — `updated_at:gte` from `syncOverlap` (default 10s) before the newest version the device holds, tombstones included — when the server versions documents; otherwise a re-read of what the device covers, deleting stored documents the server no longer returns (a failed read deletes nothing);
- reconciles each collection with the result: updates what it holds, drops what is gone, keeps documents that only exist on this device (`_adding`, `_local_only`, legacy `local:` ids).

A collection that had loaded several pages is back to its first page after a refetch, as after any new query.

### Limits

- Several tabs on one IndexedDB elect one outbox drainer with `navigator.locks`. Without Web Locks every tab may send the same queued write. The other tabs do not see the drainer's confirmations until their next read.
- `trigger()` actions are never queued.
- `flush()` drops queued writes (with a warning).
- Conflicts are resolved per field.
- With several transporters each gets its own outbox entries; the first confirmed add decides the server id.
- Retried adds are deduplicated by id (above). `trigger()` actions have no such protection; they are not queued either.
- The document and its outbox entry are two storage writes, not one transaction: a crash exactly between them leaves a pending document with no entry, which is never sent.
- The outbox has no size cap or age limit, and a queued write cannot be cancelled from the API.
- No end-to-end encryption: the server sees the data. It can be layered in a transporter.

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
- `field:neq-number`: numeric inequality after `Number(value)`
- `field:in`, `field:nin`: membership for string or number values
- `field:ne`: inequality
- `field:eq-boolean`, `field:neq-boolean`: boolean equality or inequality
- `field:eq-null`, `field:neq-null`: null equality or inequality
- `field:eq-oid`, `field:neq-oid`: ObjectId string equality or inequality for MongoDB-backed datasources
- `field:like`: regular expression match

Nested field paths are supported:

```ts
await posts.query({
  "author.id": "user-1",
  "stats.views:gte": 100,
  "published:eq-boolean": "true",
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
  "done:eq-boolean": "false",
})
```

### `matchesAllFilters(doc, filters)`

Predicate helper for checking one document.

```ts
import { matchesAllFilters } from "@livequery/client"

if (matchesAllFilters(todo, { "done:eq-boolean": "false" })) {
  console.log("todo is open")
}
```

### `parseFilters(filters)`

Pre-parses a filter object into a `ParsedFilter[]` array. Call this once per query rather than calling `matchesAllFilters` in a tight loop.

```ts
import { parseFilters, matchesParsedFilters } from "@livequery/client"

const filters = { "done:eq-boolean": "false", "createdAt:sort": "desc" }
const parsed = parseFilters(filters)

// Efficient: parse once, match many
const openTodos = todos.filter(doc => matchesParsedFilters(doc, parsed))
```

Pagination keys (`:limit`, `:before`, `:after`, `:around`, `:page`) and sort keys (`:sort` suffix) are excluded from the returned array.

### `matchesParsedFilters(doc, parsedFilters)`

Matches one document against a pre-parsed `ParsedFilter[]`. Use together with `parseFilters()` when checking many documents against the same filters.

```ts
const parsed = parseFilters({ "status": "active", "score:gte": 10 })

for (const doc of largeList) {
  if (matchesParsedFilters(doc, parsed)) {
    // ...
  }
}
```

### `getByPath(obj, path)`

Reads a value from a nested object using dot-notation path. Returns `undefined` when any segment is missing.

```ts
import { getByPath } from "@livequery/client"

const doc = { author: { profile: { name: "Ada" } } }

getByPath(doc, "author.profile.name") // "Ada"
getByPath(doc, "author.missing.field") // undefined
getByPath(doc, "title")               // undefined (not present)
```

Used internally by filter evaluation and storage sorting. Available as a public export for custom storage adapters.

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
- Mutations default to the collection's mode, except `cache-first` (and no mode), which default to `server-first`. Pass the mode explicitly to override it per call.
- `LivequeryCollection` has no initialized `metadata` subject in the current constructor, so transporter `metadata` should not be considered reliable consumer state yet.
- `trigger()` returns an observable with a Promise-like `then()` method.
- Transporter streams should emit incremental changes. Do not send full snapshots as repeated `added` events unless the client can safely deduplicate by id.
- Run `bun test` to execute the test suite. It covers collection behavior, seed loading, mutation mode defaults, query error propagation, filter parsing, sort stability, the outbox, conflict rebase, reconnect refetch, and the storage conformance suite (memory and IndexedDB).

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
