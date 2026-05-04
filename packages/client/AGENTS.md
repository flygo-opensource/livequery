# AGENTS.md

This file is for AI coding agents working in `@livequery/core`.

## Purpose

`@livequery/core` provides local-first reactive data primitives for browser clients.

This repository is a library package. Agents should optimize for reusable API design and backward compatibility, not application scaffolding or product-specific behavior.

- `LivequeryCollection` is the main consumer-facing collection/document wrapper.
- `LivequeryDocument` wraps one document in a `BehaviorSubject` and forwards mutations.
- `LivequeryCore` coordinates storage, transporters, queries, broadcasts, and optimistic mutation state.
- `LivequeryStorge` is the storage contract. The `Storge` spelling is intentional in the public API and must not be renamed casually.
- `LivequeryMemoryStorage` is the in-memory reference implementation of the storage contract.
- `LivequeryTransporter` defines the remote sync contract.

## Source Of Truth

- Edit `src/`, never `dist/`. `dist/` is build output.
- Keep ESM-style relative imports with `.js` extensions in TypeScript source.
- Preserve current public exports from `src/index.ts` unless the task explicitly changes the package API.
- Package build and publish metadata live in `package.json`.

## Project Map

- `src/LivequeryCollection.ts`: collection lifecycle, watcher subscription, sorting, local item state.
- `src/LivequeryCore.ts`: query orchestration, cache/deduping, optimistic mutation flow, collection registry, broadcasts.
- `src/LivequeryDocument.ts`: per-document wrapper over `BehaviorSubject`.
- `src/LivequeryMemoryStorage.ts`: default local storage implementation, filtering, sorting.
- `src/LivequeryStorge.ts`: storage interface.
- `src/LivequeryTransporter.ts`: transporter interface and query result shape.
- `src/types.ts`: shared public types and inline filter type system.
- `src/helpers/filterDocs.ts`: runtime filter matching used by local storage and local-first rebroadcast checks.
- `src/helpers/tryCatch.ts`, `src/helpers/whenCompleted.ts`: small async/reactive helpers.

## Runtime Model

- A collection ref has an odd number of path segments, for example `posts`.
- A document ref has an even number of path segments, for example `posts/post-1`.
- `LivequeryCollection.initialize(ref)` derives `collection_ref` from that rule and subscribes through `LivequeryCore.watch`.
- `initialize()` returns early when `window` is unavailable, so the current implementation is browser-only.
- `items`, `summary`, `loading`, `filters`, `paging`, and `error` are reactive `BehaviorSubject`s.
- Consumers needing live updates must subscribe; reading `.value` gives only a snapshot.

## How Agents Should Use The Library

When writing real consumer code with this package, prefer these patterns:

- Create one `LivequeryCore` per app data boundary with a storage adapter and transporter map.
- Create `LivequeryCollection` instances from that shared core instead of creating isolated transport layers per component.
- Call `initialize(ref)` before `query()`, `add()`, `update()`, `delete()`, or `trigger()`.
- Use collection refs like `posts` for list access and document refs like `posts/post-1` for single-document access.
- Subscribe to `items`, `loading`, `error`, `summary`, or `paging` when the UI needs live updates. Do not rely on `.value` alone for reactive rendering.
- In React or similar UI layers, bridge the `BehaviorSubject` state into framework state or a subscription hook.
- Use `query()` for immediate fetches and `debounceQuery()` only when the collection was configured with a non-zero `debounce` option.
- Use `loadMore()` and `loadPrev()` only after checking `paging.value.next` or `paging.value.prev`.
- Call mutations through the collection or document wrappers and expect optimistic metadata such as `_adding`, `_updating`, and `_deleting` to appear in local state.
- Treat transporter query streams as incremental change streams, not full snapshot replacements.

Preferred consumer shape:

1. Create `LivequeryCore` with storage and transporters.
2. Create `LivequeryCollection` with filters and mode.
3. Call `initialize(ref)`.
4. Subscribe to reactive subjects.
5. Call `query()` and later mutations.

Avoid these common mistakes in generated code:

- Do not call `query()` before `initialize()`.
- Do not read `collection.items.value` once and assume the UI will stay in sync.
- Do not treat this package as server-side-safe collection state by default.
- Do not strip internal `_` metadata fields before rendering optimistic state if the UI needs mutation progress or errors.
- Do not assume `metadata` is reliable without checking the current implementation.

## Query Modes

- `server-first`: transporters drive the query result and emit streamed change events.
- `cache-first`: first query can hydrate from storage, then transporters refresh.
- `local-first`: storage serves the query immediately, and remote query changes are broadcast back into matching collections.

Important local-first detail:

- `LivequeryCore.query()` sends empty filters to transporters in `local-first` mode.
- Local filtering is enforced by storage query results and `matchesAllFilters()` during rebroadcast of `added` events.
- If you change filter behavior, check both `LivequeryMemoryStorage.query()` and `LivequeryCore.#broadcast()`.

## Mutation Model

- `add()` stores locally first with `_adding: true` and broadcasts an `added` event.
- Local documents receive ids prefixed with `local:` until a transporter returns a persisted id.
- `update()` stores `_prev` and `_updating: true`, then pushes only changed fields derived from `_prev`.
- `delete()` is hard delete for local-only cases, but becomes soft delete with `_deleting: true` before remote confirmation when transporters exist.
- Remote errors are persisted into `_adding_error`, `_updating_error`, or `_deleting_error` and rebroadcast as local `modified` events.

## Important Constraints

- Do not rename `LivequeryStorge` without a deliberate breaking API change.
- Do not remove `.js` suffixes from TS imports.
- Do not assume SSR support in collection initialization.
- Keep optimistic metadata fields beginning with `_` intact unless the task explicitly changes mutation semantics.
- `LivequeryCollection` sorts client-side based on `:sort` filters tracked in `#keys`.
- `LivequeryMemoryStorage` supports nested field access via dot paths for filtering and sorting.

## Known Sharp Edges

- `LivequeryCollection` declares `metadata` but does not initialize it in the constructor. Any task touching metadata flow should verify this path carefully.
- `LivequeryCore.#broadcast()` only re-checks filter matching for `added` events in `local-first` mode. Modified documents that stop matching are not currently converted into removals.
- `watch(check)` in `LivequeryCollection` observes pairwise changes from each `LivequeryDocument`; it depends on document subjects being updated in place.
- Query deduplication in `LivequeryCore.#query()` is keyed by collection id plus serialized filters.

## Validation

- Preferred build check: `bun run build`
- There is no dedicated test suite in this package at the moment.
- If you change public types or exports, build before finishing.
- If you change filter behavior, verify both type-level filter keys in `src/types.ts` and runtime matching in `src/helpers/filterDocs.ts`.

## Documentation Boundary

- `README.md` is end-user documentation.
- `AGENTS.md` should stay focused on implementation guidance, repo conventions, and editing safety for agents.
