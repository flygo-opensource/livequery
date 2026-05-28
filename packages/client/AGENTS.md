# AGENTS.md

This file is for AI coding agents working in `@livequery/client`.

## Purpose

`@livequery/client` provides local-first reactive data primitives for browser clients.

This repository is a client library package. Optimize for reusable API design, backward compatibility, predictable reactive behavior, and clear contracts between storage, transporters, collections, and documents. Do not add application scaffolding or product-specific behavior unless the task explicitly asks for it.

## Source Of Truth

- Edit `src/`, never `dist/`. `dist/` is build output.
- Keep ESM-style relative imports with `.js` extensions in TypeScript source.
- Preserve public exports from `src/index.ts` unless the task explicitly changes the package API.
- Prefer the corrected public name `LivequeryStorage`. Preserve `LivequeryStorge` as a backward-compatible alias.
- Package build and publish metadata live in `package.json`.
- End-user documentation lives in `README.md`.
- Agent implementation guidance lives in this file.

## Project Map

- `src/index.ts`: public exports.
- `src/LivequeryClient.ts`: core coordinator for watchers, query orchestration, storage writes, transporter fan-out, broadcast filtering, optimistic mutation state, and action triggers.
- `src/LivequeryCollection.ts`: consumer-facing collection/document wrapper, lifecycle, watcher subscription, local item list, sorting, selection, pagination helpers, and mutation forwarding.
- `src/LivequeryDocument.ts`: per-document `BehaviorSubject` wrapper with convenience methods.
- `src/LivequeryMemoryStorage.ts`: in-memory reference implementation of `LivequeryStorage`.
- `src/LivequeryStorage.ts`: local storage contract.
- `src/LivequeryStorge.ts`: backward-compatible alias for the old misspelled storage contract name.
- `src/LivequeryTransporter.ts`: remote sync/action contract and query result shape.
- `src/types.ts`: public shared types and type-level inline filter system.
- `src/helpers/filterDocs.ts`: runtime filter matching used by memory storage and broadcast filtering.
- `src/helpers/tryCatch.ts`: transporter error wrapper.
- `src/helpers/whenCompleted.ts`: RxJS completion helper used by query cancellation.
- `src/helpers/useDispose.ts`: disposable helper used around add locks.

## Public API Summary

### `LivequeryClient`

Meaning:

`LivequeryClient` is the orchestration core. It knows which collections are watching each collection ref, runs query streams, writes transporter query changes into storage, filters local broadcasts, handles optimistic mutation metadata, and invokes transporters.

Constructor:

```ts
new LivequeryClient({
  storage,
  transporters,
})
```

Public methods:

- `watch(ref, collection_id, mode)`: registers a collection/document watcher and returns an observable stream. Usually called by `LivequeryCollection.initialize()`, not by app code.
- `query(req)`: lower-level query entry point. Usually called by `LivequeryCollection.query()`.
- `add(collection_ref, documents, mode)`: lower-level add mutation.
- `update(collection_ref, documents, mode)`: lower-level update mutation.
- `delete(collection_ref, ids, mode)`: lower-level delete mutation.
- `trigger(action)`: fans an action out to matching transporters and returns an observable.
- `flush(collection_ref)`: broadcasts local removal and clears storage through the storage adapter.
- `destroy()`: unsubscribes internal query pipelines.

Internal concepts:

- `#collections`: collection id to metadata.
- `#refs`: collection ref to watching collection ids.
- `#queries$`: query request stream.
- `#cache`: query observable dedupe cache.
- `#adding`: per-collection add lock used to delay realtime added events while a local add is being reconciled.
- `#broadcast()`: async fan-out to watchers.
- `#filterLocalEvents()`: local-first/local-only event filter using full docs from storage for `modified` events.

### `LivequeryCollection`

Meaning:

`LivequeryCollection<T>` is the main consumer-facing wrapper. It can represent a collection ref such as `todos` or a document ref such as `todos/todo-1`. It exposes reactive `BehaviorSubject`s and forwards mutations to `LivequeryClient`.

Constructor:

```ts
new LivequeryCollection<T>(client, {
  filters,
  lazy,
  debounce,
  mode,
})
```

Public state:

- `id`: uuidv7 collection id.
- `ref`: initialized ref.
- `collection_ref`: derived collection ref.
- `items`: `BehaviorSubject<LivequeryDocument<DocState<T>>[]>`.
- `summary`: `BehaviorSubject<Record<string, any>>`.
- `loading`: `BehaviorSubject<null | "all" | "next" | "prev">`.
- `filters`: `BehaviorSubject<Partial<LivequeryFilters<T>>>`.
- `paging`: `BehaviorSubject<LivequeryPaging>`.
- `selected`: `BehaviorSubject<Set<string>>`.
- `error`: `BehaviorSubject<{ code: string; message: string } | null>`.

Public methods:

- `initialize(ref)`: derives `collection_ref`, registers the watcher, and schedules an initial query unless `lazy === true`.
- `query(filters)`: runs a query and flushes current items before applying returned cached/local docs.
- `debounceQuery(filters)`: sends filters to the debounced query stream; only works when `options.debounce` is truthy.
- `sort(field, order)`: sorts current collection. Non-local-only collections query with `field:sort`; local-only collections sort current items.
- `loadMore()`: uses `paging.value.next.cursor` as `:after`.
- `loadPrev()`: uses `paging.value.prev.cursor` as `:before`.
- `loadAround(cursor)`: sets both `:after` and `:before` to the cursor.
- `add(payload, mode?)`: adds one or many docs.
- `update(payload, mode?)`: updates one or many docs. Payloads must include `id`.
- `delete(idOrIds, mode?)`: deletes one or many docs.
- `select(mode, id?)`: manages `selected` and writes `_selected` via local-only updates.
- `trigger(action, payload?, transporter_id?)`: invokes transporter action for this collection ref.
- `resetError()`: clears `error`.
- `watch(check)`: observes pairwise changes from each document and emits pairs matching `check(prev, next)`.
- `flush()`: flushes storage through the client for `collection_ref`.

Important behavior:

- `initialize()` returns early when `window` is unavailable. Do not assume SSR support.
- `items.value` is only a snapshot. UI code must subscribe to subjects or use a framework bridge.
- Mutation methods currently have a default parameter of `"server-first"`. A collection configured with `mode: "local-only"` still needs explicit `"local-only"` mutation calls if the mutation must remain local.
- `LivequeryCollection` handles local item list updates from `added`, `modified`, and `removed` events. It does not perform full filter checks itself; local event filtering belongs in `LivequeryClient`.

### `LivequeryDocument`

Meaning:

`LivequeryDocument<T>` wraps one `DocState<T>` in a `BehaviorSubject`. It is what appears inside `collection.items`.

Public methods:

- `update(data, mode?)`: calls parent collection `update()` with the current document id.
- `del(mode?)`: calls parent collection `delete()` with the current document id.
- `trigger(action, payload?)`: calls parent collection `trigger()`.
- `select(selected)`: calls parent collection `select()` for this id.

### `LivequeryStorage`

Meaning:

`LivequeryStorage` is the local persistence contract. Storage adapters are responsible for local reads/writes and should apply local filter semantics in `query()`. `LivequeryStorge` remains exported as a backward-compatible alias.

Methods:

- `query(collection, filters?)`: returns filtered documents and paging.
- `get(ref, id)`: returns one full local document or `null`.
- `add(collection, document)`: stores a document and returns the stored `DocState`.
- `update(collection, id, document)`: merges patch fields and returns the updated `DocState` or `null`.
- `delete(collection, id)`: deletes and returns the previous `DocState` or `null`.
- `flush()`: clears storage.

Agent guidance:

- Keep `get()` capable of returning full documents. Broadcast filtering needs full docs for `modified` events.
- Keep `query()` aligned with `filterDocs()` unless an adapter intentionally supports a documented superset.
- Avoid renaming the interface without a deliberate breaking change.

### `LivequeryMemoryStorage`

Meaning:

`LivequeryMemoryStorage` is a simple reference adapter. It stores collections in `Map<string, Map<string, Doc>>`, generates local ids with `uuidv7`, filters through `filterDocs()`, and sorts with nested dot-path support.

Use it for examples, tests, local-only demos, and ephemeral state. Do not treat it as durable persistence.

### `LivequeryTransporter`

Meaning:

`LivequeryTransporter` is the remote sync and action contract.

Methods:

- `query(query)`: returns an observable of partial query results.
- `add(ref, doc)`: creates a remote document.
- `update(ref, id, doc)`: patches a remote document.
- `delete(ref, id)`: deletes a remote document.
- `trigger(action)`: runs a custom remote action.

Query streams should emit incremental `DataChangeEvent`s. Do not assume query results are full snapshot replacements.

## Runtime Model

Refs:

- A collection ref has an odd number of path segments, for example `posts`.
- A document ref has an even number of path segments, for example `posts/post-1`.
- `LivequeryCollection.initialize(ref)` derives `collection_ref` from this rule and subscribes through `LivequeryClient.watch()`.

Reactive state:

- `items`, `summary`, `loading`, `filters`, `paging`, `selected`, and `error` are `BehaviorSubject`s.
- Consumers needing live updates must subscribe. Reading `.value` gives only a snapshot.
- In React or similar frameworks, bridge `BehaviorSubject` state into framework state or a subscription hook.

Event model:

- Transporters and broadcasts use incremental `DataChangeEvent`s.
- `added` generally includes full `data`.
- `modified` can be a partial patch.
- `removed` usually only needs `id`.

## Query Modes

### `server-first`

Transporters drive query results. Collection state is built from transporter-emitted events.

Use for remote-source-of-truth data.

### `cache-first`

The first query can hydrate from storage, then transporters refresh.

Use for fast initial rendering with remote refresh.

### `local-first`

Storage serves the query immediately. Transporter query changes are written into storage and rebroadcast to matching local collections.

Important:

- `LivequeryClient.query()` sends empty filters to transporters in `local-first` mode.
- Local filtering is enforced by storage query results and by `LivequeryClient.#filterLocalEvents()`.
- Remote changes should be written into storage before broadcast because local filtering may read full docs with `storage.get()`.

### `local-only`

Queries read only from storage and skip transporters. Mutations are local-only only when the method receives `mode: "local-only"` explicitly.

Use for drafts, temporary UI state, offline-only documents, and local workspaces.

## Broadcast Filtering Rules

`LivequeryClient.#broadcast()` is async. Do not call it as fire-and-forget when editing client internals.

For `local-first` and `local-only` collection watchers:

- `added`: forward only if `event.data` matches `collection.filters`.
- `modified`: get the full document from storage, then forward only if the full doc matches filters.
- `modified` that no longer matches becomes `removed` for that collection.
- `removed`: forward as-is.

Within a single broadcast call, storage reads for modified docs are cached by `collection_ref/id` in a map of `Promise<Doc | null>`. This avoids repeated `storage.get()` calls when multiple collections watch the same collection ref with different filters.

Current limitation:

- A `modified` event that makes a previously absent document start matching a filtered collection is not converted into `added` yet. Do not silently assume this is handled. If a task asks for full filter membership correctness, design membership tracking or a collection-side presence check deliberately.

## Mutation Model

### `add()`

- `server-first`: creates local ids for push payloads and pushes directly through transporters.
- `local-first`: stores locally with `_adding: true`, broadcasts `added`, pushes to transporters, then clears `_adding` or records `_adding_error`.
- `local-only`: stores locally with `_adding: true` and `_local_only: true`, broadcasts `added`, and skips transporters.
- Local documents receive ids prefixed with `local:` until a transporter returns persisted data.

### `update()`

- `server-first`: pushes the provided fields to transporters.
- `local-first`: reads the old local doc, records old values in `_prev`, stores `_updating: true`, broadcasts `modified`, pushes changed fields to transporters, then clears `_prev` and `_updating` or records `_updating_error`.
- `local-only`: updates storage and broadcasts `modified`, but skips transporters.

### `delete()`

- `server-first`: pushes delete to transporters.
- Local-only cases and local `local:` ids are hard-deleted locally.
- When transporters exist, non-local deletes first mark `_deleting: true`, broadcast `modified`, then hard-delete after remote confirmation.
- Remote errors are persisted into `_deleting_error` and rebroadcast as `modified`.

## Filters

Type-level filters live in `src/types.ts`. Runtime matching lives in `src/helpers/filterDocs.ts`.

Supported runtime operators:

- `field`: strict equality
- `field:sort`: sorting key
- `field:gt`, `field:gte`, `field:lt`, `field:lte`
- `field:eq-number`, `field:neq-number`
- `field:in`, `field:nin`
- `field:ne`
- `field:eq-boolean`, `field:neq-boolean`
- `field:eq-null`, `field:neq-null`
- `field:eq-oid`, `field:neq-oid`
- `field:like`
- pagination keys beginning with `:` are ignored by runtime matching

Nested dot paths are supported by runtime filtering and memory storage sorting.

If you change filter behavior:

- Update type-level keys in `src/types.ts` if needed.
- Update runtime behavior in `src/helpers/filterDocs.ts`.
- Verify `LivequeryMemoryStorage.query()`.
- Verify `LivequeryClient.#filterLocalEvents()`.
- Update README examples and this AGENTS file if behavior changes.

## How Agents Should Use The Library In Consumer Code

Preferred shape:

1. Create one `LivequeryClient` per app data boundary.
2. Provide a storage adapter and transporter map.
3. Create `LivequeryCollection` instances from that shared client.
4. Call `initialize(ref)` before query/mutation/trigger calls.
5. Subscribe to reactive subjects.
6. Call `query()` for immediate fetches.
7. Use collection or document mutation wrappers.

Example:

```ts
import {
  LivequeryClient,
  LivequeryCollection,
  LivequeryMemoryStorage,
  type Doc,
} from "@livequery/client"

type Todo = Doc<{
  title: string
  done: boolean
  createdAt: number
}>

const client = new LivequeryClient({
  storage: new LivequeryMemoryStorage(),
  transporters: {
    primary: apiTransporter,
  },
})

const todos = new LivequeryCollection<Todo>(client, {
  mode: "cache-first",
  filters: {
    "createdAt:sort": "desc",
  },
})

todos.initialize("todos")

const sub = todos.items.subscribe((items) => {
  render(items.map((item) => item.value))
})

await todos.query({
  ":limit": 20,
  "done:eq-boolean": "false",
})

await todos.add({
  title: "Write docs",
  done: false,
  createdAt: Date.now(),
})

sub.unsubscribe()
```

React-style bridge:

```tsx
function TodoList({ collection }: { collection: LivequeryCollection<Todo> }) {
  const [items, setItems] = useState(() => collection.items.value)

  useEffect(() => {
    const sub = collection.items.subscribe(setItems)
    return () => sub.unsubscribe()
  }, [collection])

  return items.map((item) => (
    <button key={item.value.id} onClick={() => item.update({ done: !item.value.done })}>
      {item.value.title}
    </button>
  ))
}
```

## Common Mistakes To Avoid

- Do not call `query()`, `add()`, `update()`, `delete()`, or `trigger()` before `initialize(ref)`.
- Do not read `collection.items.value` once and assume UI will stay reactive.
- Do not treat this package as server-side-safe by default.
- Do not remove `.js` suffixes from TypeScript imports.
- Do not remove the `LivequeryStorge` alias.
- Do not strip `_` metadata fields when UI needs mutation state.
- Do not assume `metadata` is reliable; `LivequeryCollection` currently does not initialize a metadata subject.
- Do not send full snapshots as repeated transporter events without checking collection dedupe behavior.
- Do not call async `#broadcast()` inside `tap()` without converting it into the RxJS stream with `from(...)`, `mergeMap`, `concatMap`, or equivalent.
- Do not add unrelated app framework code to this library.

## Editing Guidance By Area

### Changing query behavior

- Inspect `LivequeryClient.#start()`, `LivequeryClient.#query()`, and `LivequeryClient.query()`.
- Preserve dedupe cache cleanup with `finalize(clear)`.
- Preserve loading state semantics: `"all"`, `"next"`, `"prev"`, or `null`.
- For RxJS async work, do not hide promises in `tap()`.

### Changing broadcast behavior

- Check all callsites of `#broadcast()`.
- Keep async callsites awaited.
- Preserve document watcher behavior: document refs receive only matching id events.
- Preserve local collection filtering for `local-first` and `local-only`.
- Keep storage writes before broadcast when filtering depends on full local docs.
- Keep per-broadcast doc cache unless there is a better measured design.

### Changing mutation behavior

- Check all three modes: `server-first`, `local-first`, `local-only`.
- Preserve optimistic fields unless the task explicitly changes mutation semantics.
- Preserve `_prev` behavior so remote update payloads include only changed fields.
- Preserve local-only behavior that skips transporters.
- Consider multiple transporters. Current code fans out through transporter entries.

### Changing collection item handling

- Review `LivequeryCollection.initialize()` event handling.
- Keep `#indexes` synchronized with `items`.
- Preserve sort handling through `#keys`.
- Be careful with document `BehaviorSubject`s being updated in place.
- If changing filtering, remember collection does not have storage/full docs; client currently owns full-doc filter checks.

### Changing storage

- Keep `LivequeryStorage` methods async.
- Keep nested dot-path behavior aligned between filtering and sorting.
- Return full documents from `get()`.
- Return updated/deleted docs where the interface expects them.

### Changing public types or exports

- Update `src/index.ts`.
- Update `package.json` `exports` and `typesVersions` if adding public entry points.
- Update README public exports and API docs.
- Run `bun run build`.

## Known Sharp Edges

- `LivequeryCollection` declares no initialized `metadata` subject, so metadata flow is not consumer-safe yet.
- `modified -> added` for local filtered collections is not handled: if a document was absent because it did not match filters and a later modified event makes it match, it is not currently inserted as `added`.
- `LivequeryCollection` only calls `items.next(...)` through `#commit()`. Pure document `modified` events update document subjects in place and may not emit a new `items` array unless sorting/removal/addition forces a commit.
- Query deduplication in `LivequeryClient.#query()` is keyed by collection id plus `JSON.stringify(filters)`, so object key order can affect dedupe.
- `flush(collection_ref)` broadcasts for one collection ref but calls storage `flush()` with no collection argument, so storage is cleared broadly.
- Collection mutation method parameters default to `"server-first"`, so collection `options.mode` does not automatically become the mutation default.

## Validation

- Preferred build check: `bun run build`.
- There is no dedicated test suite in this package at the moment.
- If you change public types or exports, build before finishing.
- If you change filter behavior, verify both type-level filters and runtime matching.
- If you change RxJS query/broadcast flow, build and reason through async ordering.

## Documentation Boundary

- Keep `README.md` focused on end-user library usage and examples.
- Keep `AGENTS.md` focused on implementation guidance, repo conventions, AI usage patterns, and editing safety.
- Update both files when behavior changes in a way that affects consumers or future agents.
