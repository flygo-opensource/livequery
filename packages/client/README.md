# @livequery/new

A local-first reactive data library for browser clients. It provides a type-safe, RxJS-based collection system with pluggable storage and transporter adapters, optimistic local mutations, and real-time synchronisation support.

## Table of Contents

- [Architecture](#architecture)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Core Concepts](#core-concepts)
  - [LivequeryDocument](#livequerydocument)
  - [LivequeryStorge](#livequerystorge)
  - [LivequeryTransporter](#livequerytransporter)
  - [LivequeryCore](#livequerycore)
  - [LivequeryCollection](#livequerycollection)
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
│   LivequeryCollection (BehaviorSubject)
│        query / add / update / delete│
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
2. The core applies the change locally to storage *immediately* (optimistic update).
3. The change is broadcast to all live collections watching the same `ref`.
4. The core then calls every configured transporter to sync the change remotely.

**Data flow for a query:**
1. `LivequeryCollection.query(filters)` calls `LivequeryCore.query`.
2. The core returns locally-stored documents instantly from storage.
3. In parallel, it fires the query against every transporter.
4. Each transporter response streams `DataChangeEvent[]` back into the collection, which merges them reactively.

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
import { of } from "rxjs"
import {
  LivequeryCollection,
  LivequeryCore,
  LivequeryMemoryStorage,
  type LivequeryDocument,
  type LivequeryQueryParams,
  type LivequeryQueryResult,
  type LivequeryTransporter,
  type LivequeryAction,
} from "@livequery/new"

// 1. Define your document shape
type Todo = LivequeryDocument & {
  title: string
  done: boolean
  createdAt: number
}

// 2. Create a storage (in-memory for this example)
const storage = new LivequeryMemoryStorage()

// 3. Create a transporter (no-op for this example; replace with your real backend)
const transporter: LivequeryTransporter = {
  name: "primary",
  query<T extends LivequeryDocument>(query: LivequeryQueryParams<T>) {
    return of<Partial<LivequeryQueryResult<T>>>({
      query_id: query.query_id,
      changes: [],
      summary: {},
      paging: { total: 0, current: 0 },
      metadata: {},
      source: "query",
    })
  },
  trigger<T>(_action: LivequeryAction<LivequeryDocument>) {
    return of({ data: {} as T })
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
const todos = new LivequeryCollection<Todo>(core, {
  ref: "todos",
  filters: { "createdAt:sort": "desc", ":limit": 20, ":page": 1, ":before": "", ":after": "" },
  lazy: true,
})

// 6. Subscribe to state changes
todos.subscribe((state) => {
  console.log("items:", state.items.map((doc$) => doc$.value))
  console.log("loading:", state.loading)
  console.log("paging:", state.paging)
})

// 7. Trigger an initial query
await todos.query({ "createdAt:sort": "desc", ":limit": 20, ":page": 1, ":before": "", ":after": "" })

// 8. Mutate data
await todos.add({ title: "Buy milk", done: false, createdAt: Date.now() })
await todos.update("some-id", { done: true })
await todos.delete("some-id")

---

## Core Concepts

### LivequeryDocument

Every document stored in livequery must extend `LivequeryDocument`:

```ts
type LivequeryDocument = {
  id: string                                  // unique identifier
  _remotes: { [target: string]: string | number | true } // sync state per transporter
  _prev: Record<string, any>                  // previous field values (for conflict resolution)
  _deleting?: boolean                         // marks document as pending deletion
  [key: string]: any
}
```

Your own types extend this base:

```ts
type Post = LivequeryDocument & {
  title: string
  body: string
  publishedAt: number
}
```

---

### LivequeryStorge

`LivequeryStorge` is the interface for local persistence. The library ships with `LivequeryMemoryStorage`. You can create adapters for `localStorage`, `IndexedDB`, SQLite, etc.

```ts
type LivequeryStorge = {
  query<T extends LivequeryDocument>(
    collection: string,
    filters?: Record<string, any>
  ): Promise<{ documents: T[]; paging: LivequeryPaging }>

  get<T extends LivequeryDocument>(ref: string, id: string): Promise<T | null>
  add<T extends LivequeryDocument>(collection: string, document: T): Promise<T>
  update<T extends LivequeryDocument>(collection: string, id: string, document: Record<string, any>): Promise<T | null>
  delete<T extends LivequeryDocument>(collection: string, id: string): Promise<T | null>
}
```

---

### LivequeryTransporter

A transporter connects the core to a remote backend (REST API, WebSocket, Firebase, etc.). You can provide **multiple** transporters; the core fans out queries and mutations to all of them.

```ts
type LivequeryTransporter = {
  name: string

  // Called for every query. Returns an Observable so remotes can stream partial results
  // (e.g., first respond with cached data, then real-time updates).
  query<T extends LivequeryDocument>(
    query: LivequeryQueryParams<T>
  ): Observable<Partial<LivequeryQueryResult<T>>>

  // Called for add/update/delete/custom actions.
  trigger<T>(action: LivequeryAction<LivequeryDocument>): Observable<{ data: T; error?: Error }>
}
```

The `query` method must emit `query_id` in every response so the core can route results to the correct collection.

---

### LivequeryCore

The central coordinator. Instantiate once and share across your app.

```ts
const core = new LivequeryCore({
  storage,                  // LivequeryStorge implementation
  transporters: {           // one or more LivequeryTransporter instances
    primary: myTransporter,
  },
  resolver,                 // ConflictResolverFunction – see below
})
```

#### Conflict resolver

The resolver is called during every local mutation. It decides whether to approve the change and what the final merged document should look like.

```ts
type ConflictResolverFunction = <T extends LivequeryDocument>(e: {
  from: Record<string, string | number | boolean>  // remote versions (_remotes)
  old_document: T                                  // current local document
  change: DataChangeEvent<T>                       // incoming change
}) => {
  approved: boolean   // if false, the change is discarded
  document: T         // the resolved document to store
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

`LivequeryCollection<T>` extends RxJS `BehaviorSubject` and holds the reactive state for one collection path (`ref`).

```ts
const posts = new LivequeryCollection<Post>(core, {
  ref: "posts",
  filters: { "publishedAt:sort": "desc", ":limit": 10, ":page": 1, ":before": "", ":after": "" },
  lazy: true,   // true = don't load on construction; false = auto-load
})
```

The emitted `LivequeryCollectionState<T>` value has the shape:

```ts
type LivequeryCollectionState<T extends LivequeryDocument> = {
  ref: string
  items: Array<BehaviorSubject<T>>    // each item is itself a BehaviorSubject
  indexes: Map<string, number>        // id → index in items array
  summary: Record<string, any>        // aggregation data from transporter
  metadata?: Record<string, any>      // arbitrary metadata from transporter
  filters?: Partial<LivequeryFilters<T>>
  loading: {
    all: boolean    // initial query in progress
    next: boolean   // loading next page
    prev: boolean   // loading previous page
  }
  paging: LivequeryPaging
}
```

Each `items[i]` is a `BehaviorSubject<T>`, so you can subscribe to individual document changes:

```ts
posts.value.items[0].subscribe((doc) => console.log("doc changed:", doc))
```

---

## Query Filters

Filters are type-safe. The compiler will only allow valid field paths and operators for your document type.

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
type Article = LivequeryDocument & {
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

An in-memory `LivequeryStorge` implementation backed by a `Map`. Data is lost on page reload.

```ts
const storage = new LivequeryMemoryStorage()
```

| Method | Signature | Description |
|--------|-----------|-------------|
| `query` | `(collection, filters?) → Promise<{documents, paging}>` | Filter, sort and paginate documents |
| `get` | `(collection, id) → Promise<T \| null>` | Fetch a single document by id |
| `add` | `(collection, document) → Promise<T>` | Upsert a document |
| `update` | `(collection, id, partial) → Promise<T \| null>` | Merge partial into existing document |
| `delete` | `(collection, id) → Promise<T \| null>` | Remove and return a document |
| `seed` | `(collection, docs[]) → void` | Bulk-load initial documents (replaces existing) |
| `clear` | `(collection?) → void` | Clear one collection or all collections |

```ts
// Seed test data
storage.seed<Todo>("todos", [
  { id: "1", _remotes: {}, _prev: {}, title: "Write docs", done: false, createdAt: Date.now() }
])

// Clear a specific collection
storage.clear("todos")

// Clear everything
storage.clear()
```

---

### LivequeryCollection methods

| Method | Description |
|--------|-------------|
| `query(filters)` | Execute a fresh query with new filters |
| `loadMore()` | Append next page (uses `paging.next.cursor`) |
| `loadPrev()` | Prepend previous page (uses `paging.prev.cursor`) |
| `loadAround(cursor)` | Load items around a specific cursor (both directions) |
| `add(payload)` | Optimistically add a new document |
| `update(id, payload)` | Optimistically update a document |
| `delete(id)` | Optimistically delete a document |
| `trigger(action, payload?)` | Fire a custom action (e.g. `"~publish"`) |
| `unsubscribe()` | Tear down the collection and its watcher |

```ts
// Infinite scroll — load next page
await todos.loadMore()

// Cursor-based navigation
await todos.loadAround("cursor-abc")

// Custom action (handled by your transporter)
await todos.trigger("~sendEmail", { to: "user@example.com" })
```

---

### WorkerRpc

`WorkerRpc` is a utility for calling services across a `SharedWorker` boundary using an RxJS / Promise-compatible API.

#### Expose a service inside a SharedWorker

```ts
// worker.ts
import { WorkerRpc } from "@livequery/new"

class DataService {
  async getUser(id: string) {
    return { id, name: "Alice" }
  }
}

WorkerRpc.exposeWorkerService(new DataService())
```

#### Consume the service in the main thread

```ts
// main.ts
import { WorkerRpc } from "@livequery/new"

const worker = new SharedWorker(new URL("./worker.ts", import.meta.url), { type: "module" })

// Returns a typed proxy. Each property access builds the method path.
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
import type { LivequeryTransporter, LivequeryDocument, LivequeryQueryParams, LivequeryQueryResult, LivequeryAction } from "@livequery/new"

const httpTransporter: LivequeryTransporter = {
  name: "http",

  query<T extends LivequeryDocument>(params: LivequeryQueryParams<T>) {
    return new Observable<Partial<LivequeryQueryResult<T>>>(subscriber => {
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

  trigger<T>(action: LivequeryAction<LivequeryDocument>) {
    return new Observable<{ data: T }>(subscriber => {
      fetch(`/api/${action.ref}`, {
        method: action.action === "delete" ? "DELETE" : action.action === "add" ? "POST" : "PATCH",
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
import type { LivequeryStorge, LivequeryDocument, LivequeryPaging } from "@livequery/new"

class LocalStorageAdapter implements LivequeryStorge {
  private read<T>(collection: string): T[] {
    return JSON.parse(localStorage.getItem(collection) ?? "[]")
  }
  private write<T>(collection: string, docs: T[]) {
    localStorage.setItem(collection, JSON.stringify(docs))
  }

  async query<T extends LivequeryDocument>(collection: string, filters?: Record<string, any>) {
    const docs = this.read<T>(collection)
    // apply filters, sort, paginate ...
    return { documents: docs, paging: { total: docs.length, current: docs.length } }
  }

  async get<T extends LivequeryDocument>(collection: string, id: string) {
    return this.read<T>(collection).find(d => d.id === id) ?? null
  }

  async add<T extends LivequeryDocument>(collection: string, document: T) {
    const docs = this.read<T>(collection)
    const i = docs.findIndex(d => d.id === document.id)
    if (i >= 0) docs[i] = document; else docs.push(document)
    this.write(collection, docs)
    return document
  }

  async update<T extends LivequeryDocument>(collection: string, id: string, patch: Record<string, any>) {
    const docs = this.read<T>(collection)
    const i = docs.findIndex(d => d.id === id)
    if (i < 0) return null
    docs[i] = { ...docs[i], ...patch }
    this.write(collection, docs)
    return docs[i]
  }

  async delete<T extends LivequeryDocument>(collection: string, id: string) {
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
// Core document base
type LivequeryDocument = { id: string; _remotes: Record<string, string|number|true>; _prev: Record<string,any>; _deleting?: boolean; [key:string]:any }

// Change event emitted by transporters / core
type DataChangeEvent<T> = { id: string; type: "added" | "updated" | "removed"; data?: Partial<Omit<T,"id">> | null }

// Query parameters sent to transporters
type LivequeryQueryParams<T> = { ref: string; query_id: string; collection_id: string; filters?: Partial<LivequeryFilters<T>>; headers?: Record<string,string> }

// Result streamed back from a transporter query
type LivequeryQueryResult<T> = { query_id: string; changes: DataChangeEvent<T>[]; summary: Record<string,any>; paging: LivequeryPaging; metadata: Record<string,any>; source: "query"|"action"|"realtime" }

// Action sent to transporters
type LivequeryAction<T> = { ref: string; collection_id: string; action: "add"|"update"|"delete"|`~${string}`; payload?: Record<string,any>; filters?: Partial<LivequeryFilters<T>>; headers?: Record<string,string> }

// Paging info
type LivequeryPaging = { total: number; current: number; next?: { count: number; cursor: string }; prev?: { count: number; cursor: string } }
```

---

## Build

```bash
bun run build
```

Build output is placed in `dist/` as ESM with TypeScript declarations. The target is browser ESM (`--target browser`).

```bash
bun run build:watch   # watch mode (JS only)
bun run clean         # remove dist/
```
