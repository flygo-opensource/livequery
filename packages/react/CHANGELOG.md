# Changelog — @livequery/react

## 3.0.1

### Changed
- No code changes. Released with `@livequery/client` 3.0.1, which fixes local-first deltas and `update()` with a snapshot of the document.

## 3.0.0

### Breaking
- Peer dependency `@livequery/client` is now `^3.0.0`. The hooks take on the 3.x client's behaviour, including the new `local-first` semantics; see the `@livequery/client` changelog.

### Changed
- `useCollection` re-renders the component when anything the collection shows changes: its items, the value of any document in it, `loading`, `error`, `paging`, `summary`, `filters`, `selected` or `completeness`. Changes are batched into one render per microtask (`useSyncExternalStore`). Components can read `collection.items.value` and similar values directly, without `useObservable` (ebf791a).
- `useDocument` builds on it and returns `[document, loading, error]` from the collection's current values. Its options now also accept `context`.

### Added
- README: hosting the client in a SharedWorker through `createRemoteLivequeryClient` and `@livequery/rpc`, with `new SharedWorker(url, { extendedLifetime: true })` so the worker's socket survives a reload of the only tab (69afde6).

Migrating from 2.x: see [MIGRATION.md](../../MIGRATION.md).

## 2.x
Released from the pre-monorepo repositories; no changelog was kept.
