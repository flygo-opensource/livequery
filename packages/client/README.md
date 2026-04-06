# @livequery/new

A local-first reactive data library for browser clients. Type-safe, RxJS-based collection system with pluggable storage and transporter adapters, optimistic local mutations, and real-time synchronisation support.

## Table of Contents

- [Architecture](#architecture)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Core Concepts](#core-concepts)
  - [Doc](#doc)
  - [LivequeryStorge](#livequerystorge)
  - [LivequeryTransporter](#livequerytransporter)
  - [LivequeryCore](#livequerycore)
  - [LivequeryCollection](#livequerycollection)
  - [LivequeryDocument](#livequerydocument)
- [Query Filters](#query-filters)
- [API Reference](#api-reference)
  - [LivequeryMemoryStorage](#livequerymemorystorage)
  - [LivequeryCollection methods](#livequerycollection-methods)
  - [WorkerRpc](#workerrpc)
- [Writing a Custom Transporter](#writing-a-custom-transporter)
- [Writing a Custom Storage Adapter](#writing-a-custom-storage-adapter)
- [Types Reference](#types-reference)

---

## Architecture

```
┌─────────────────────────────────────┐
│          Your Application           │
│  LivequeryCollection                │
│  .items / .loading / .paging        │
│  .query() / .add() / .update() / .delete()
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│           LivequeryCore             │
│  - coordinates storage & transport  │
│  - optimistic local mutations       │
│  - broadcasts changes to collections│
└───────┬──────────────┬──────────────┘
        │              │
┌───────▼──────┐ ┌─────▼──────────────┐
│ LivequeryStorge│ │ LivequeryTransporter│
│  (local)     │ │  (remote backend)   │
│              │ │  (can be many)      │
└──────────────┘ └────────────────────┘
```

**Data flow for a mutation (add / update / delete):**
1. `LivequeryCollection.add/update/delete` calls `LivequeryCore.trigger`.
2. The core applies the change to storage immediately (optimistic update).
3. The change is broadcast to all live collections watching the same `ref`.
4. The core then calls every configured transporter to sync the change remotely.

**Data flow for a query:**
1. `LivequeryCollection.query(filters)` calls `LivequeryCore.query`.
2. The core returns locally-stored documents instantly from storage.
3. In parallel, it fires the query against every transporter.
4. Each transporter streams `DataChangeEvent[]` back into the collection, which merges them reactively.

---

## Installation

```bash
npm install @livequery/new rxjs
# or
bun add @livequery/new rxjs
```

---

## Quick Start

```ts
import {
  LivequeryCollection,
  LivequeryCore,
  LivequeryMemoryStorage,
  type Doc,
  type LivequeryTransporter,
} from "@livequery/new"
import { of } from "rxjs"

// 1. Define your document shape
type Todo = Doc & {
  title: string
  done: boolean
  createdAt: number
}

// 2. Create a storage (in-memory for this example)
const storage = new LivequeryMemoryStorage()

// 3. Create a transporter (no-op; replace with your real backend)
const transporter: LivequeryTransporter = {
  query(query) {
    return of({ query_id: query.query_id, changes: [], summary: {}, paging: { total: 0, current: 0 }, metadata: {}, source: "query" })
  },
  trigger(_action) {
    return of({ data: {} as any })
  },
}

// 4. Create the core
const core = new LivequeryCore({
  storage,
  transporters: { primary: transporter },
  resolver: ({ change, old_document }) => ({
    approved: true,
    document: { ...old_document, ...change.data } as Todo,
  }),
})

// 5. Create a reactive collection
const todos = new LivequeryCollection<Todo>({
  core,
  ref: "todos",
  filters: { "createdAt:sort": "desc", ":limit": 20, ":page": 1, ":before": "", ":after": "" },
  lazy: true,
})

// 6. Call initialize() to start watching (required)
todos.initialize()

// 7. Subscribe to reactive state
todos.items.subscribe((docs) => {
  console.log("items:", docs.map((doc$) => doc$.value))
})
todos.loading.subscribe((state) => console.log("loading:", state))
todos.paging.subscribe((p) => console.log("paging:", p))

// 8. Trigger a query
await todos.query({ "createdAt:sort": "desc", ":limit": 20, ":page": 1, ":before": "", ":after": "" })

// 9. Mutate data
await todos.add({ title: "Buy milk", done: false, createdAt: Date.now() })
await todos.update("some-id", { done: true })
await todos.delete("some-id")
```

---

## Core Concepts

### Doc

Every document stored in livequery must extend `Doc<T>`:

```ts
type Doc<T = {}> = T & {
  id: string
}
```

Your types extend this base:

```ts
type Post = Doc & {
  title: string
  body: string
  publishedAt: number
}
```

When a document is held inside a `LivequeryCollection`, it is wrapped in `DocState<T>` which adds optimistic-update tracking fields:

```ts
type DocState<T extends Doc> = T & {
  _deleting?: boolean    // pending deletion
  _updating?: boolean    // pending update
  _adding?: boolean      // pending add
  _remotes?: Record<string, string | number>  // per-transporter version cursors
  _prev?: Partial<T>     // previous values before last local mutation
}
```

---

### LivequeryStorge

`LivequeryStorge` is the interface for local persistence. The library ships with `LivequeryMemoryStorage`. You can create adapters for `localStorage`, `IndexedDB`, SQLite, etc.

```ts
type LivequeryStorge = {
  query<T extends Doc>(
    collection: string,
    filters?: Record<string, any>
  ): Promise<{ documents: T[]; paging: LivequeryPaging }>

  get<T extends Doc>(ref: string, id: string): Promise<T | null>
  add<T extends Doc>(collection: string, document: T): Promise<T>
  update<T extends Doc>(collection: string, id: string, document: Record<string, any>): Promise<T | null>
  delete<T extends Doc>(collection: string, id: string): Promise<T | null>
}
```

---

### LivequeryTransporter

A transporter connects the core to a remote backend (REST API, WebSocket, Firebase, etc.). You can provide **multiple** transporters; the core fans out queries and mutations to all of them.

```ts
type LivequeryTransporter = {
  // Called for every query. Returns an Observable so the remote can stream results.
  query<T extends Doc>(
    query: LivequeryQueryParams<T>
  ): Observable<Partial<LivequeryQueryResult<T>>>

  // Called for add / update / delete / custom actions.
  trigger<T>(action: LivequeryAction): Observable<{ data: T; error?: Error }>
}
```

---

### LivequeryCore

The central coordinator. Instantiate once and share across your app.

```ts
const core = new LivequeryCore({
  storage,                      // LivequeryStorge implementation
  transporters: {               // one or more named transporters
    primary: myTransporter,
  },
  resolver,                     // ConflictResolverFunction
})
```

#### Conflict resolver

Called for every local mutation. Decides whether to approve the change and what the final merged document should be.

```ts
type ConflictResolverFunction = <T extends Doc>(e: {
  from: Record<string, string | number | boolean>  // remote version cursors (_remotes)
  old_document: T                                  // current local document
  change: DataChangeEvent<T>                       // incoming change
}) => {
  approved: boolean   // false → discard the change
  document: T         // resolved document to persist
}
```

Simple last-write-wins example:

```ts
const resolver: ConflictResolverFunction = ({ change, old_document }) => ({
  approved: true,
  document: { ...old_document, ...change.data } as typeof old_document,
})
```

---

### LivequeryCollection

`LivequeryCollection<T>` holds reactive state for one collection path (`ref`). Its state is exposed as a set of `BehaviorSubject` properties.

```ts
const posts = new LivequeryCollection<Post>({
  core,
  ref: "posts",
  filters: { "publishedAt:sort": "desc", ":limit": 10, ":page": 1, ":before": "", ":after": "" },
  lazy: true,   // true = don't auto-load on initialize(); false = load immediately
})

// Must call initialize() to wire up the core watcher
posts.initialize()
```

#### Reactive state properties

| Property | Type | Description |
|----------|------|-------------|
| `items` | `BehaviorSubject<LivequeryDocument<DocState<T>>[]>` | Current list of documents |
| `loading` | `BehaviorSubject<LivequeryLoadingState>` | Loading flags |
| `filters` | `BehaviorSubject<Partial<LivequeryFilters<T>>>` | Active filters |
| `paging` | `BehaviorSubject<LivequeryPaging>` | Pagination info |
| `summary` | `BehaviorSubject<Record<string, any>>` | Aggregation data from transporter |
| `metadata` | `BehaviorSubject<Record<string, any>>` | Arbitrary metadata from transporter |

```ts
posts.items.subscribe((docs) => console.log(docs.map(d => d.value)))
posts.loading.subscribe(({ all, next, prev }) => console.log({ all, next, prev }))
```

`LivequeryLoadingState`:

```ts
type LivequeryLoadingState = {
  all: boolean   // initial query in progress
  next: boolean  // loading next page
  prev: boolean  // loading previous page
}
```

---

### LivequeryDocument

Each element of `collection.items.value` is a `LivequeryDocument<DocState<T>>`, which extends `BehaviorSubject<T>`. It provides convenient mutation helpers scoped to that document.

```ts
class LivequeryDocument<T extends Doc> extends BehaviorSubject<T> {
  update(data: Partial<T>): Promise<void>
  del(): Promise<void>
  trigger<R>(action: LivequeryActionType, payload: Record<string, any>): Observable<{ data: R; error?: Error }>
}
```

```ts
const doc = posts.items.value[0]

// Subscribe to individual document changes
doc.subscribe((post) => console.log("post changed:", post))

// Mutate directly on the document
await doc.update({ title: "Updated title" })
await doc.del()

// Fire a custom action
doc.trigger("~publish", { scheduledAt: Date.now() }).subscribe()
```

---

## Query Filters

Filters are fully type-safe. The TypeScript compiler will only allow valid field paths and operators for your document type.

### Pagination / sorting

| Key | Type | Description |
|-----|------|-------------|
| `"<field>:sort"` | `"asc" \| "desc"` | Sort by a string field |
| `":limit"` | `number` | Max items per page |
| `":page"` | `number` | Page number (1-based) |
| `":before"` | `string` | Cursor for previous-page fetch |
| `":after"` | `string` | Cursor for next-page fetch |

### Field operators

| Operator | Applies to | Description |
|----------|-----------|-------------|
| `gt` | `number` | Greater than |
| `gte` | `number` | Greater than or equal |
| `lt` | `number` | Less than |
| `lte` | `number` | Less than or equal |
| `eq-number` | `number` | Strict numeric equality |
| `in` | `number \| string` | Value is in array |
| `nin` | `number \| string` | Value is NOT in array |
| `include` | `number[] \| string[]` | Array field includes value |
| `boolean` | `boolean` | `"true"`, `"false"`, `"not-true"`, `"not-false"` |
| `like` | `string` | Case-insensitive substring match |
| `null` | any | `"null-only"` or `"not-null"` |

```ts
type Article = Doc & {
  score: number
  tags: string[]
  title: string
  archived: boolean
  deletedAt: number | null
}

const filters: LivequeryFilters<Article> = {
  "score:gte": 5,
  "tags:include": "typescript",
  "title:like": "livequery",
  "archived:boolean": "false",
  "deletedAt:null": "null-only",
  "score:sort": "desc",
  ":limit": 20,
  ":page": 1,
  ":before": "",
  ":after": "",
}
```

---

## API Reference

### LivequeryMemoryStorage

An in-memory `LivequeryStorge` implementation backed by a `Map`. Data is lost on page reload. Useful for testing and offline-first prototypes.

```ts
const storage = new LivequeryMemoryStorage()
```

| Method | Signature | Description |
|--------|-----------|-------------|
| `query` | `(collection, filters?) → Promise<{documents, paging}>` | Filter, sort and paginate documents |
| `get` | `(collection, id) → Promise<T \| null>` | Fetch a single document by id |
| `add` | `(collection, document) → Promise<T>` | Upsert a document (insert or replace by id) |
| `update` | `(collection, id, partial) → Promise<T \| null>` | Merge partial fields into existing document |
| `delete` | `(collection, id) → Promise<T \| null>` | Remove and return a document |
| `seed` | `(collection, docs[]) → void` | Bulk-load documents (replaces existing) |
| `clear` | `(collection?) → void` | Clear one collection or all collections |

```ts
storage.seed<Todo>("todos", [
  { id: "1", title: "Write docs", done: false, createdAt: Date.now() }
])

storage.clear("todos")   // clear one collection
storage.clear()          // clear everything
```

---

### LivequeryCollection methods

| Method | Description |
|--------|-------------|
| `initialize()` | Wire up the core watcher and optionally auto-load (required before use) |
| `query(filters)` | Execute a fresh query replacing current items |
| `loadMore()` | Append next page using `paging.next.cursor` |
| `loadPrev()` | Prepend previous page using `paging.prev.cursor` |
| `loadAround(cursor)` | Load items around a specific cursor (both directions) |
| `add(payload)` | Optimistically add a new document |
| `update(id, payload)` | Optimistically update a document |
| `delete(id)` | Optimistically delete a document |
| `trigger(action, payload?)` | Fire a custom action (e.g. `"~publish"`) |

```ts
// Paginate
await collection.loadMore()
await collection.loadPrev()
await collection.loadAround("cursor-abc")

// Mutate
await collection.add({ title: "New item", done: false, createdAt: Date.now() })
await collection.update("doc-id", { done: true })
await collection.delete("doc-id")

// Custom action handled by your transporter
collection.trigger("~sendEmail", { to: "user@example.com" }).subscribe()
```

---

### WorkerRpc

`WorkerRpc` is a utility for calling services across a `SharedWorker` boundary using an Observable / Promise-compatible API.

#### Expose a service inside a SharedWorker

```ts
// worker.ts
import { WorkerRpc } from "@livequery/new"

class DataService {
  async getUser(id: string) {
    return { id, name: "Alice" }
  }
}

const rpc = new WorkerRpc()
rpc.exposeWorkerService(new DataService())
```

#### Consume the service in the main thread

```ts
// main.ts
import { WorkerRpc } from "@livequery/new"

const worker = new SharedWorker(new URL("./worker.ts", import.meta.url), { type: "module" })

// Returns a typed proxy
const service = WorkerRpc.linkWorkerService<DataService>("DataService", worker)

// Call as a Promise
const user = await service.getUser("123")

// Or subscribe as an Observable (for streaming methods)
service.getUser("123").subscribe((user) => console.log(user))
```

The proxy is transparent — if the underlying method returns an `Observable`, the proxy streams values back; if it returns a `Promise` or plain value, it resolves once.

---

## Writing a Custom Transporter

Implement `LivequeryTransporter` to connect to any backend:

```ts
import { Observable } from "rxjs"
import type {
  LivequeryTransporter, Doc,
  LivequeryQueryParams, LivequeryAction
} from "@livequery/new"

const httpTransporter: LivequeryTransporter = {
  query<T extends Doc>(params: LivequeryQueryParams<T>) {
    return new Observable(subscriber => {
      fetch(`/api/${params.ref}?${new URLSearchParams(params.filters as any)}`)
        .then(r => r.json())
        .then(data => {
          subscriber.next({
            query_id: params.query_id,
            changes: data.items.map((item: T) => ({ id: item.id, type: "added", data: item })),
            paging: data.paging,
            summary: data.summary ?? {},
            metadata: {},
            source: "query",
          })
          subscriber.complete()
        })
        .catch(err => subscriber.error(err))
    })
  },

  trigger<T>(action: LivequeryAction) {
    return new Observable<{ data: T }>(subscriber => {
      const method = action.action === "delete" ? "DELETE"
        : action.action === "add" ? "POST" : "PATCH"
      fetch(`/api/${action.ref}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action.payload),
      })
        .then(r => r.json())
        .then(data => { subscriber.next({ data }); subscriber.complete() })
        .catch(err => subscriber.error(err))
    })
  },
}
```

---

## Writing a Custom Storage Adapter

Implement `LivequeryStorge` to persist data in `localStorage`, `IndexedDB`, SQLite, etc.:

```ts
import type { LivequeryStorge, Doc, LivequeryPaging } from "@livequery/new"

class LocalStorageAdapter implements LivequeryStorge {
  private read<T>(collection: string): T[] {
    return JSON.parse(localStorage.getItem(collection) ?? "[]")
  }
  private write<T>(collection: string, docs: T[]) {
    localStorage.setItem(collection, JSON.stringify(docs))
  }

  async query<T extends Doc>(collection: string, filters?: Record<string, any>) {
    const docs = this.read<T>(collection)
    // apply filters, sort, paginate …
    return { documents: docs, paging: { total: docs.length, current: docs.length } }
  }

  async get<T extends Doc>(collection: string, id: string) {
    return this.read<T>(collection).find(d => d.id === id) ?? null
  }

  async add<T extends Doc>(collection: string, document: T) {
    const docs = this.read<T>(collection)
    const i = docs.findIndex(d => d.id === document.id)
    if (i >= 0) docs[i] = document; else docs.push(document)
    this.write(collection, docs)
    return document
  }

  async update<T extends Doc>(collection: string, id: string, patch: Record<string, any>) {
    const docs = this.read<T>(collection)
    const i = docs.findIndex(d => d.id === id)
    if (i < 0) return null
    docs[i] = { ...docs[i], ...patch }
    this.write(collection, docs)
    return docs[i]
  }

  async delete<T extends Doc>(collection: string, id: string) {
    const docs = this.read<T>(collection)
    const i = docs.findIndex(d => d.id === id)
    if (i < 0) return null
    const [removed] = docs.splice(i, 1)
    this.write(collection, docs)
    return removed ?? null
  }
}
```

---

## Types Reference

```ts
// Base document type — all documents must have an `id`
type Doc<T = {}> = T & { id: string }

// Document state inside a collection (tracks optimistic-update flags)
type DocState<T extends Doc> = T & {
  _deleting?: boolean
  _updating?: boolean
  _adding?: boolean
  _remotes?: Record<string, string | number>
  _prev?: Partial<T>
}

// Change event emitted by transporters and the core
type DataChangeEvent<T extends Doc> = {
  id: string
  type: "added" | "updated" | "removed"
  data?: Partial<Omit<T, "id">> | null
}

// Query parameters forwarded to every transporter
type LivequeryQueryParams<T extends Doc> = {
  ref: string
  query_id: string
  collection_id: string
  filters?: Partial<LivequeryFilters<T>>
  headers?: Record<string, string>
}

// Result streamed back from a transporter query
type LivequeryQueryResult<T extends Doc> = {
  query_id: string
  changes: DataChangeEvent<T>[]
  summary: Record<string, any>
  paging: LivequeryPaging
  metadata: Record<string, any>
  source: "query" | "action" | "realtime"
}

// Action sent to every transporter for mutations
type LivequeryAction = {
  ref: string
  collection_id: string
  action: "add" | "update" | "delete" | `~${string}`
  payload?: Record<string, any>
  headers?: Record<string, string>
}

// Pagination info
type LivequeryPaging = {
  total: number
  current: number
  next?: { count: number; cursor: string }
  prev?: { count: number; cursor: string }
}
```

---

## Build

```bash
bun run build
```

Output is placed in `dist/` as ESM with TypeScript declarations (browser target).

```bash
bun run build:watch   # watch mode (JS only, no type declarations)
bun run clean         # remove dist/
```
