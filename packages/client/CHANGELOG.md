# Changelog — @livequery/client

## 3.0.1

### Added
- `LivequeryQueryResult.sync`: set when the server says a route serves local-first sync (`mongodb({ sync: true })`).

### Fixed
- Local-first scopes read deltas only when the server's reads say `sync: true`. 3.0.0 guessed this from a numeric `updated_at`, so documents deleted on a non-sync route stayed on the device. The `versioned` flag that 3.0.0 stored on each scope is now ignored, so each device re-reads its scopes once.
- `add()` / `update()` ignore client write-state fields passed in by the caller (`_adding`, `_prev`, `_updating`, `_queued`, `_deleting`, `*_error`, `_remotes`, `_index`, `_local_only`). Before this, `update({ ...doc.value, x })` showed the edit on screen but never sent it.

## 3.0.0

In 2.x, `local-first` meant: read from storage, and in the background page through the whole collection (with empty filters) into storage, then filter locally. There was no outbox, so a write that failed offline got an error flag and was never sent again. In 3.x, `local-first` is a real offline-first mode. It has declared sync scopes, delta reads, a durable outbox, client-chosen uuidv7 ids, and conflict detection through `If-Match` / 409.

### Breaking
- **Local-first reads come from `LivequerySync` scopes.** The old "page through the whole collection" pipeline is gone. `mode: 'local-first'` is now the same as `mode: {}`, which means scope `full`, `keep: '10m'` and `evict: '30d'`. `mode` also takes `{ scope: 'full' | 'window' | 'on-demand', size, sort, keep, evict, children }`. After the first load, a scope only reads deltas (`updated_at` + tombstones) from routes that serve sync; on other routes it re-reads what it holds. A local-first collection pages through storage, and `loadMore()` goes to the server only when the local page comes back short (3c28278).
- **Local-first writes go through the durable outbox** (`client.outbox`, stored under `__livequery_outbox`). Some failures are retryable: network errors, timeouts, 5xx, 401, 408 and 429. For those, the mutation resolves with the local document marked `_queued: true`, and `_adding` / `_updating` / `_prev` / `_deleting` stay set until the server confirms. In 2.x the same failure set `_adding_error` / `_updating_error` / `_deleting_error`. Other 4xx responses still set the error flag (39ff8c6, 352300b).
- **`add()` generates a uuidv7 id instead of `local:<uuidv7>`.** It also keeps an `id` the caller passes; 2.x always replaced it. The id is sent to the server, and 3.x datasources store it, so it no longer changes after sync. To tell whether a document is still unsynced, check `_adding`, not the `local:` prefix (61e3aed).
- **Every remote change now goes through one ingest step, in all modes.** That step drops a change whose numeric `updated_at` is older than the stored copy. It also treats a document with `deleted_at` set as a tombstone: the document is deleted locally and reported as `removed` (`VERSION_FIELD`, `TOMBSTONE_FIELD`) (e0d0e28, c1d0ee2).
- **Storages now apply `:limit` / `:after` / `:before`** with keyset cursors and return `paging.next` / `paging.prev`. In 2.x, storages returned every match. Custom `LivequeryStorage` adapters must page the same way; `defineStorageConformanceSuite` in `@livequery/client/testing` checks it (6534722).
- Local sort order now follows MongoDB's BSON order (null < numbers < strings < objects < arrays < booleans; strings by code point) instead of JS `<` (1180522).
- Local-first updates send the document's `updated_at` as `options.if_version`, which `@livequery/rest` sends as the `If-Match` header. A sync route answers 409 `VERSION_CONFLICT`; the client then pulls the server's copy, rebases the local edit on it and retries (23f492f).

### Added
- `LivequeryIndexedDBStorage` (new entry point `./LivequeryIndexedDBStorage`). Raw IndexedDB with no runtime dependency; it falls back to memory where `indexedDB` does not exist, and pages from indexes (773f556, 0240e29).
- `@livequery/client/testing` exports `defineStorageConformanceSuite({ name, create, dispose?, describe, test, expect })`.
- `LivequeryOutbox`: `client.outbox`, `outbox.pending$`, `outbox.trigger()`. With a shared storage, tabs elect one outbox drainer through `navigator.locks` (`LivequeryStorage.shared?`).
- `LivequerySync`: `client.sync`; `LocalFirstConfig`, `LocalFirstScope`, `LivequeryMode`, `LivequeryCompleteness`; `collection.completeness`.
- `LivequeryClientConfig.conflictResolver`: `ConflictResolverFunction` is now actually used. It receives `{ from, old_document, change }` and returns `{ approved, document }`. Without it, locally edited fields win until their write is confirmed.
- `LivequeryClientConfig.syncOverlap`: how far a delta reaches back before the newest version held (default 10 000 ms).
- `client.retry(ref, ids)` / `collection.retry(id)`: sends again an add or delete the server refused, with the same id (6c03567).
- `client.refetch()`: runs automatically when a transporter's `status$` reconnects. Results carry `refetch: true` and collections reconcile them (a2130c0).
- `livequery/status` document (`LIVEQUERY_STATUS_REF`, `LivequeryStatus` with `{ connected, offline, online, pending }`), `client.status$` and `client.setOffline()`. Updating that document with `{ offline: true }` simulates a lost network (5068ce8).
- `createRemoteLivequeryClient` and `LivequeryClientLike`: a `LivequeryCollection` can run against a client hosted in a SharedWorker through `@livequery/rpc` (ebf791a).
- `LivequeryTransporter`, all optional: `status$`, `read()`, and `update(..., options?: LivequeryWriteOptions)` with `if_version`. `LivequeryQueryResult` gains `refetch` and `completeness`.
- `DocMetadata._queued`; errors carry the HTTP `status`.
- Crash recovery: each local-first write records an intent first, so a crash between the document write and its outbox entry loses nothing (4dd4083).

### Changed
- Server-first `update()` now stores the values from *before* the edit in `_prev` (never `id`); 2.x stored the new values (b97208a).
- `stopLocalSyncing()` now forgets what the local-first scopes hold, so each one reloads from the server on next use.
- The `LivequeryStorge` type (typo) is still exported as an alias of `LivequeryStorage`, as in 2.x. Prefer `LivequeryStorage`.

### Fixed
- Two concurrent adds no longer break each other's add lock (it is now refcounted, `AddLock`), so realtime echoes are still deferred (b97208a).
- A remote change no longer overwrites an unconfirmed local edit. A pending delete ignores remote `modified` events (c1d0ee2).
- Re-queries (a reconnect, new filters) no longer stack live streams and multiply realtime events (a2130c0).
- A local-first collection no longer drops a confirmed add from its items. Deleting an unsynced document no longer calls `transporter.add`. A replayed delete that gets 404 counts as done.
- A batch listing the same removal twice no longer removes the next item.
- A read that delivers a held document as `added` now updates it, and `synced_at` no longer runs ahead of the catch-up (9fe8c2a).
- Deltas overlap the last sync by `syncOverlap`, and sync reads respect the offline switch (a2b5c7e).

Migrating from 2.x: see [MIGRATION.md](../../MIGRATION.md).

## 2.x
Released from the pre-monorepo repositories; no changelog was kept.
