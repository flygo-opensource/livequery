# @livequery/core

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
1. `LivequeryCollection.add/update/delete` calls `LivequeryCore.add/update/delete`.
2. The core applies the change to local storage immediately (optimistic update).
3. The change is broadcast to all live collections watching the same `ref`.
4. The core then calls every configured transporter to push the change remotely.

**Data flow for a query:**
1. `LivequeryCollection.query(filters)` calls `LivequeryCore.query`.
2. The core returns locally-stored documents instantly from storage.
3. In parallel, it fires the query against every transporter.
4. Each transporter streams `DataChangeEvent[]` back into the collection, which merges them reactively.

---

## Installation

```bash
npm install @livequery/core rxjs
# or
bun add @livequery/core rxjs
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
} from "@livequery/core"
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
  query(_query) {
    return of({ changes: [], summary: {}, paging: { total: 0, current: 0 }, metadata: {}, source: "query" as const })
  },
  add: async (_ref, doc) => ({ ...doc, id: crypto.randomUUID() } as any),
  update: async (_ref, _id, doc) => doc as any,
  delete: async (_ref, _id) => ({} as any),
  trigger: async (_action) => ({} as any),
}

// 4. Create the core
const core = new LivequeryCore({
  storage,
  transporters: { primary: transporter },
})

// 5. Create a reactive collection and initialize it
const todos = new LivequeryCollection<Todo>({ filters: { "createdAt:sort": "desc" } })
todos.initialize(core, "todos")

// 6. Subscribe to reactive state
todos.items.subscribe((docs) => {
  console.log("items:", docs.map((doc) => doc.value))
})
todos.loading.subscribe((state) => console.log("loading:", state))
todos.paging.subscribe((p) => console.log("paging:", p))

// 7. Query with filters
await todos.query({ "createdAt:sort": "desc", ":limit": 20 })

// 8. Mutate data
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
  // Called for every query. Returns an Observable so the remote can stream realtime updates.
  query<T extends Doc>(
    query: LivequeryQueryParams<T>
  ): Observable<Partial<LivequeryQueryResult>>

  // Called for optimistic mutations
  add<T extends Doc>(ref: string, doc: Omit<T, 'id'>): Promise<T>
  update<T extends Doc>(ref: string, id: string, doc: Partial<T>): Promise<T>
  delete<T extends Doc>(ref: string, id: string): Promise<T>

  // Called for custom actions
  trigger<T>(action: LivequeryAction): Promise<T>
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
})
```

---

### LivequeryCollection

`LivequeryCollection<T>` holds reactive state for one collection path (`ref`). Its state is exposed as a set of `BehaviorSubject` properties.

```ts
const posts = new LivequeryCollection<Post>({
  filters: { "publishedAt:sort": "desc" },
  lazy: true,    // true = don't auto-load on initialize(); false = load immediately (default)
  debounce: 300, // optional debounce time in ms for debounceQuery()
})

// Wire up the core and the collection path, then start watching
posts.initialize(core, "posts")
```

#### Reactive state properties

| Property | Type | Description |
|----------|------|-------------|
| `items` | `BehaviorSubject<LivequeryDocument<DocState<T>>[]>` | Current list of documents |
| `loading` | `BehaviorSubject<LivequeryLoadingState \| null>` | `null`, `'all'`, `'next'`, or `'prev'` |
| `filters` | `BehaviorSubject<Partial<LivequeryFilters<T>>>` | Active filters |
| `paging` | `BehaviorSubject<LivequeryPaging>` | Pagination info |
| `summary` | `BehaviorSubject<Record<string, any>>` | Aggregation data from transporter |
| `metadata` | `BehaviorSubject<Record<string, any>>` | Arbitrary metadata from transporter |
| `error` | `BehaviorSubject<{code: string, message: string} \| null>` | Last error from transporter |

```ts
posts.items.subscribe((docs) => console.log(docs.map(d => d.value)))
posts.loading.subscribe((state) => console.log("loading:", state))
// state is null | 'all' | 'next' | 'prev'
```

---

### LivequeryDocument

Each element of `collection.items.value` is a `LivequeryDocument<DocState<T>>`, which extends `BehaviorSubject<T>`. It provides convenient mutation helpers scoped to that document.

```ts
class LivequeryDocument<T extends Doc> extends BehaviorSubject<T> {
  update(data: Partial<T>): Promise<void>
  del(): Promise<void>
  trigger<R>(action: string, payload: Record<string, any>): Observable<{ data: R; error?: Error }>
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
doc.trigger("publish", { scheduledAt: Date.now() }).subscribe()
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
| `clear` | `(collection?) → void` | Clear one collection or all collections |

```ts
storage.clear("todos")   // clear one collection
storage.clear()          // clear everything
```

---

### LivequeryCollection methods

| Method | Description |
|--------|-------------|
| `initialize(core, ref)` | Wire up the core for a given collection path; optionally auto-loads (required before use) |
| `query(filters)` | Execute a fresh query replacing current items |
| `debounceQuery(filters)` | Queue a debounced query (uses the `debounce` option) |
| `loadMore()` | Append next page using `paging.next.cursor` |
| `loadPrev()` | Prepend previous page using `paging.prev.cursor` |
| `loadAround(cursor)` | Load items around a specific cursor (both directions) |
| `add(payload)` | Optimistically add a new document |
| `update(id, payload)` | Optimistically update a document |
| `delete(id)` | Optimistically delete a document |
| `trigger(action, payload?)` | Fire a custom action via the transporter |
| `watch(check)` | Returns an Observable that emits when a document changes, filtered by `check` |
| `resetError()` | Clear the current `error` state |

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
collection.trigger("sendEmail", { to: "user@example.com" }).subscribe()

// Watch for field changes across all items
collection.watch((prev, next) => prev.done !== next.done).subscribe(([prev, next]) => {
  console.log("done changed", prev, next)
})
```

---

## Writing a Custom Transporter

Implement `LivequeryTransporter` to connect to any backend:

```ts
import { Observable } from "rxjs"
import type {
  LivequeryTransporter, Doc,
  LivequeryQueryParams, LivequeryAction
} from "@livequery/core"

const httpTransporter: LivequeryTransporter = {
  query<T extends Doc>(params: LivequeryQueryParams<T>) {
    return new Observable(subscriber => {
      fetch(`/api/${params.ref}?${new URLSearchParams(params.filters as any)}`)
        .then(r => r.json())
        .then(data => {
          subscriber.next({
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

  async add<T extends Doc>(ref: string, doc: Omit<T, 'id'>) {
    const res = await fetch(`/api/${ref}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc),
    })
    return res.json() as Promise<T>
  },

  async update<T extends Doc>(ref: string, id: string, doc: Partial<T>) {
    const res = await fetch(`/api/${ref}/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc),
    })
    return res.json() as Promise<T>
  },

  async delete<T extends Doc>(ref: string, id: string) {
    const res = await fetch(`/api/${ref}/${id}`, { method: "DELETE" })
    return res.json() as Promise<T>
  },

  async trigger<T>(action: LivequeryAction) {
    const res = await fetch(`/api/${action.ref}/${action.action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(action.payload),
    })
    return res.json() as Promise<T>
  },
}
```

---

## Writing a Custom Storage Adapter

Implement `LivequeryStorge` to persist data in `localStorage`, `IndexedDB`, SQLite, etc.:

```ts
import type { LivequeryStorge, Doc, LivequeryPaging } from "@livequery/core"

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
  _remotes?: Record<string, string | number>  // per-transporter version cursors
  _prev?: Partial<T>                          // previous values before last local mutation
}

// Change event emitted by transporters and the core
type DataChangeEvent = {
  collection_ref: string
  id: string
  type: 'added' | 'removed' | 'modified'
  data?: Record<string, any>
}

// Query parameters forwarded to every transporter
type LivequeryQueryParams<T extends Doc> = {
  ref: string
  filters?: Partial<LivequeryFilters<T>>
  headers?: Record<string, string>
}

// Result streamed back from a transporter query
type LivequeryQueryResult = {
  error: { code: string, message: string }
  changes: DataChangeEvent[]
  summary: Record<string, any>
  paging: LivequeryPaging
  metadata: Record<string, any>
  source: 'query' | 'action' | 'realtime'
}

// Action sent to a transporter for custom operations
type LivequeryAction = {
  ref: string
  action: string
  payload?: Record<string, any>
}

// Pagination info
type LivequeryPaging = {
  total: number
  current: number
  next?: { count: number; cursor: string }
  prev?: { count: number; cursor: string }
}

// Loading state for a collection
type LivequeryLoadingState = null | 'next' | 'prev' | 'all'
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
