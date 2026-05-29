# Query Modes in @livequery/client

`LivequeryCollection` has four modes that control how queries and mutations interact with local storage and remote transporters. Understanding the difference prevents silent data problems and UI flicker.

## Quick Comparison

| | `server-first` | `cache-first` | `local-first` | `local-only` |
|---|---|---|---|---|
| **Initial query reads from** | Transporter | Storage, then transporter in background | Storage immediately | Storage only |
| **Transporter called?** | Yes, always | Yes, after cache hydration | Yes, in background | No |
| **loading state during query** | `"all"` until server responds | `"all"` briefly (from cache), then background refresh | `"all"` until storage resolves | No loading state |
| **Realtime events** | Received and applied | Received and applied | Received, written to storage, rebroadcast locally | Not received |
| **Default mutation behavior** | Pushes to server | Pushes to server | Optimistic local + server sync | Stays local |
| **Use when** | Server is truth, cache optional | Fast first paint + background refresh | Offline-first, instant UI | Drafts, temporary state |

---

## Collection Mode vs Mutation Mode

These are two separate concerns.

**Collection mode** (`LivequeryCollectionOptions.mode`) controls how `query()` works and which events are received.

**Mutation mode** (`mode` parameter on `add`, `update`, `delete`) controls how writes are executed. It defaults to the collection's mode, except `cache-first` which defaults to `server-first` for mutations.

```ts
// Collection queries cache-first, but mutations default to server-first
const todos = new LivequeryCollection<Todo>(client, { mode: 'cache-first' })

await todos.add({ title: 'A', done: false })           // server-first (default)
await todos.add({ title: 'B', done: false }, 'local-only') // explicit override
```

---

## `server-first`

**The server is the source of truth. Local storage is a secondary cache.**

### Query flow

```
collection.query(filters)
    │
    ├─▶ storage cleared (flush=true)
    ├─▶ setTimeout → #queries$.next()
    │
    ▼
LivequeryClient#start() picks up query
    │
    ├─▶ loading: "all" emitted to collection
    ├─▶ transporter.query(filters) called
    │       │
    │       ├─▶ each change written to storage
    │       └─▶ changes emitted via data$
    │
    └─▶ loading: null emitted
```

Items arrive through the transporter stream, not directly from `client.query()`. The function returns `undefined` for server-first — items are delivered asynchronously via the watch stream.

### Mutation flow

```
collection.add(payload)
    │
    ├─▶ id = "local:<uuid>" assigned
    ├─▶ transporter.add() called → awaits server response
    ├─▶ storage updated with server response (real id)
    └─▶ broadcast: modified event with server id
```

All mutations block on server response. The optimistic local id is replaced with the server-assigned id after confirmation.

### When to use

- Admin dashboards where stale data is unacceptable
- Small datasets that load quickly
- When you have no offline requirement

```ts
const users = new LivequeryCollection<User>(client, { mode: 'server-first' })
users.initialize('users')
// lazy: false (default) → auto-queries on initialize
```

---

## `cache-first`

**Hydrate from cache instantly, then refresh from server in background.**

### Query flow

```
collection.query(filters)          (first query, no :before/:after)
    │
    ├─▶ storage.query() called → items emitted immediately from cache
    ├─▶ setTimeout → #queries$.next()
    │
    ▼
LivequeryClient#start() picks up query
    │
    ├─▶ loading: "all" emitted (background)
    ├─▶ transporter.query() called
    │       └─▶ changes written to storage, emitted via data$
    │
    └─▶ loading: null emitted
```

For pagination queries (`:before` / `:after`), cache is skipped and the transporter is called directly.

### Mutation flow

Same as `server-first`. Mutations default to `server-first` because `cache-first` has no meaningful "optimistic" behavior for writes.

```ts
#defaultMode(): ActionMode {
    return !this.options.mode || this.options.mode === 'cache-first' ? 'server-first' : this.options.mode
}
```

### When to use

- Social feeds, content lists where showing stale data briefly is acceptable
- Any list where perceived performance matters more than instant freshness
- Apps that use IndexedDB or a persistent storage adapter

```ts
const posts = new LivequeryCollection<Post>(client, {
    mode: 'cache-first',
    filters: { 'createdAt:sort': 'desc' }
})
posts.initialize('posts')
// User sees cached posts instantly while fresh data loads in background
```

---

## `local-first`

**Storage serves the query immediately. Transporter syncs everything in the background, including all pages.**

### Query flow

```
collection.query(filters)
    │
    ├─▶ storage.query() called with empty filters → full local dataset returned
    ├─▶ setTimeout → #queries$.next()
    │
    ▼
LivequeryClient#start() (local-first branch)
    │
    ├─▶ loading: "all" emitted (only on first query per collection_ref)
    ├─▶ transporter.query({}) called (empty filters — server gets all data)
    │       └─▶ auto-paginates via :after cursor until exhausted
    │       └─▶ each page written to storage, broadcast to local collections
    │
    └─▶ collections receive broadcast events filtered by their local filters
```

**Key difference**: Filters are not sent to the server. The server returns everything; local collections filter in the broadcast step. This is why it can serve instant results from storage while the full dataset syncs.

### Mutation flow

```
collection.add(payload)       (local-first)
    │
    ├─▶ storage.add() called → id = "local:<uuid>", _adding: true
    ├─▶ broadcast: added event to all matching local collections
    │
    ▼ (background)
    ├─▶ lock acquired on collection_ref
    ├─▶ transporter.add() called
    ├─▶ storage.update() → replaces local id with server id, _adding: undefined
    └─▶ broadcast: modified event with server id
```

Optimistic: the item appears immediately with a local id. The server id replaces it after sync. If the server fails, `_adding_error` is set on the document.

### When to use

- Offline-capable apps that need to work without network
- Apps where all data must be synced locally (e.g., mobile-like PWA)
- When you want instant sort/filter without round trips

```ts
const notes = new LivequeryCollection<Note>(client, {
    mode: 'local-first',
    filters: { 'title:like': searchTerm }
})
notes.initialize('notes')
// Items appear instantly from storage, server syncs in background
```

> **Note:** Because the server receives empty filters, the entire collection is synced locally. Avoid this mode for large unbounded datasets — use `cache-first` with cursor pagination instead.

---

## `local-only`

**Storage only. No transporter involvement.**

### Query flow

```
collection.query(filters)
    │
    ├─▶ storage.query(filters) called
    ├─▶ results broadcast as "added" events to collection
    └─▶ no transporter called, no loading state set
```

There is no async loading phase. Items appear synchronously from storage. `loading` stays `null`.

### Mutation flow

```
collection.add(payload, 'local-only')
    │
    ├─▶ storage.add() called → _adding: true, _local_only: true
    ├─▶ broadcast: added event
    └─▶ no transporter call, no server sync
```

Mutations only touch storage. Documents stay local until explicitly promoted to a server-aware mode.

### When to use

- UI state (selected items, expanded rows, unsaved form state)
- Draft documents before the user hits "save"
- Offline workspaces or local scratch pads

```ts
const drafts = new LivequeryCollection<Draft>(client, { mode: 'local-only' })
drafts.initialize('drafts')

await drafts.add({ title: '', body: '' }, 'local-only')
// User edits draft... when ready to publish:
await serverCollection.add(drafts.items.value[0].value, 'server-first')
await drafts.delete(draftId, 'local-only')
```

---

## Realtime Events Across Modes

When the transporter emits realtime change events (e.g., from a WebSocket), the client distributes them to all registered collections. Each mode handles them differently:

| Mode | On realtime `added` | On realtime `modified` | On realtime `removed` |
|------|------|------|------|
| `server-first` | Applied directly | Applied directly | Applied directly |
| `cache-first` | Applied directly | Applied directly | Applied directly |
| `local-first` | Matched against collection filters, forwarded if match | Full doc read from storage, forwarded if still matches; converted to `removed` if no longer matches | Forwarded |
| `local-only` | Not received | Not received | Not received |

---

## Mutation Mode Reference

Mutation methods (`add`, `update`, `delete`) accept an optional explicit mode as the last argument:

| Explicit mode | Behavior |
|---|---|
| `server-first` | Block until server responds. Server id replaces local id. Error throws. |
| `local-first` | Optimistic local write, then server sync in background. `_adding`/`_updating`/`_deleting` flags while pending. |
| `local-only` | Storage only. `_local_only: true` on adds. Never sent to server. |

The default when no mode is passed:

```ts
#defaultMode(): ActionMode {
    // cache-first falls back to server-first for mutations
    return !this.options.mode || this.options.mode === 'cache-first' ? 'server-first' : this.options.mode
}
```

So a `local-first` collection's mutations default to `local-first`, and a `local-only` collection's mutations default to `local-only`. A `cache-first` collection's mutations default to `server-first`.

---

## Common Mistakes

**Expecting items immediately after `query()` in server-first mode**

```ts
// ✗ Wrong — items come async via watch stream, not from query() return value
await collection.query({})
console.log(collection.items.value) // may be empty

// ✓ Correct — subscribe to items
collection.items.subscribe(items => console.log(items))
await collection.query({})
```

**Using `local-first` for large datasets**

`local-first` syncs the entire collection locally (server receives empty filters). For a dataset with 100k documents this will attempt to paginate and store all of them.

```ts
// ✗ Risky for large collections
const events = new LivequeryCollection(client, { mode: 'local-first' })

// ✓ For large collections, prefer cache-first with pagination
const events = new LivequeryCollection(client, { mode: 'cache-first' })
```

**Forgetting that mutation mode is separate from collection mode**

```ts
// Collection queries locally, but this add goes to server (server-first default)
const local = new LivequeryCollection(client, { mode: 'local-only' })
await local.add({ title: 'Draft' })            // ✗ server-first! collection mode doesn't override
await local.add({ title: 'Draft' }, 'local-only') // ✓ explicit
```

**Checking `loading` after `local-only` query**

`local-only` never emits a loading state. If you check `loading.value !== null` as a "query in flight" signal, it will always be `null` for local-only collections.
