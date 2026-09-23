# TODO

## Fixed in 3.0.0

### `@livequery/mongodb`: bare `retry()` in `MongodbRealtime.#listenRawChanges` spun the CPU when `collMod` failed

- Reported 2026-09-16, fixed 2026-09-22.
- `#listenRawChanges` ran `collMod` before `collection.watch()`. With a `readWrite`-only Mongo user
  the command failed with `Unauthorized` (13), the error reached a bare `retry()` with no delay and
  no limit, and the pipeline re-issued `collMod` as fast as the driver allowed: ~200 commands/s per
  process, ~6,000 `Unauthorized` lines/s in the `mongod` log, and nothing at all in the app log.
- In production (24aff) that was 22 of 56 PM2 services at 100–140% CPU for 45 days, ~3.7 GB RSS
  each, host load ~39 on 80 cores.

What changed in `packages/mongodb/src/MongodbRealtime.ts`:

1. `collMod` runs in a try/catch. A failure is reported and the collection is remembered, so the
   doomed command is not re-issued on later resubscribes. The watcher starts either way —
   `old_data` already falls back to `documentKey` when pre-images are missing.
2. `retry()` became `retry({ delay })` with exponential backoff, `reconnectDelayMs` (1000) to
   `maxReconnectDelayMs` (30000), matching `PostgresRealtime`.
3. New `onError` option reports both stages. Without it, failures go to `console.error` — they are
   never silent again.
4. `packages/mongodb/README.md` documents the `collMod` privilege and the `collModOnly` role.

Tests in `packages/mongodb/tests/MongodbRealtime.test.ts`: the watcher starts when `collMod` is
refused, `collMod` is not re-issued afterwards, and a dropped stream waits out the backoff instead
of resubscribing immediately.

**Downstream:** 24aff can drop the `bun patch` entries in `24aff/server/patches/` and bump to
`@livequery/mongodb@3.0.0`. The `collModOnly` role granted there is still worth keeping — it buys
full before-images on delete.

**Not done:** `@livequery/mongodb-mapper@2.0.58` has the same bare `retry()` and is not in this
repo. Deprecate it and point at `@livequery/mongodb`, or patch it separately.

## Open

### ~~Realtime drops updates across a reconnect~~ — done (`4e56527`)

The gateway keeps the changes for a client inside its grace window and sends them after its
reconnect's `hello`; beyond the window the client re-reads (server-first) or reads a delta
(local-first). Left: the buffer is in memory, so a gateway restart loses it.

### ~~`Socket` replays stale `unsubscribe` frames after a reconnect~~ — done (`f405fb8`)

Confirmed by a test, then fixed: frames go to the open connection only; those made while it is
down are sent once on the next open, minus unsubscribes for refs listened to again.

### ~~A half-open socket makes the reconnect close itself~~ — done on branch `worktree-offline-first`

Fixed in commit `9fe8c2a` after the chat demo hit it behind the NetBird proxy (realtime dead
until the old TCP timed out): the newest connection for a `client_id` now takes over, its
subscriptions move over, and the old socket's late close detaches nothing. Same commit: the
`Socket` reconnect backoff now resets once a connection opens (it grew to 30s after a few drops).

### A SharedWorker's WebSocket drops (1006) at every full-page navigation

Seen 2026-09-23 in headless Chrome against the NetBird-published demo: navigating any page of the
worker's origin (not pushState) drops the worker's socket with 1006. It reconnects in ~2s and the
sync delta covers the gap, so nothing is lost, but the cause (Chrome, H2 WebSockets, or the proxy)
is unknown.

## Merged into `main` (2026-09-24) — offline-first for `@livequery/client`

Approved and implemented 2026-09-23 on branch `worktree-offline-first` (pushed to origin, not
merged), one commit per increment:
[`packages/client/OFFLINE_FIRST_PLAN.md`](packages/client/OFFLINE_FIRST_PLAN.md) — all 6
increments ticked, plus where the implementation departs from the plan. It closes write-path items
1, 2, 3 and 5 below and the client half of "Realtime drops updates across a reconnect".

Verified 2026-09-23: `bun run build`, `bun run test` (all packages), and the root e2e suite against
the LAN replica set (114 tests, including `ws-reconnect`, both fullstack client suites, and
`local-first-sync` — two devices, offline CRUD on one, concurrent edits on the other, convergence).
The Hono fullstack suite now writes through a `z.strictObject` validator. The plan file has a
table comparing the implementation against the local-first ideals.

Still open after it (listed under Limits in `packages/client/README.md`):

- ~~Idempotency key~~ — **done differently** (commit `61e3aed`): clients choose uuidv7 ids, the
  datasources store them (Mongo as a BSON UUID `_id`) and answer 409 `ID_ALREADY_EXISTS` on a
  duplicate; a retried add that gets 409 is treated as created. `clientIds: false` per route turns
  it off. Mongo e2e 121/121. Remaining: `trigger()` actions have no dedupe (not queued either).
- A crash between writing the document and its outbox entry leaves a pending document that is
  never sent; needs a repair pass at boot.
- No outbox size cap / TTL, no API to cancel a queued write, no data export, no E2E encryption.

Also on the branch since (2026-09-23), driven by the chat demo:

- Declarative sync (`3c28278`): `mode: { scope: 'full' | 'window' | 'on-demand', size, sort, keep,
  evict, children }`, run by `LivequerySync` inside the client; local keyset paging (`6534722`);
  versioned ingest with `updated_at` / `deleted_at` tombstones (`e0d0e28`).
- `livequery/status` document + offline switch (`5068ce8`); `createRemoteLivequeryClient` for a
  client hosted in a SharedWorker, and `useCollection` / `useDocument` re-render on their own, no
  `useObservable` needed (`ebf791a`).
- `@livequery/mongodb` `sync: true` routes: `updated_at` on writes, tombstones, delta reads,
  verified on the LAN replica set (`5df5c63`).
- Fixes found in the browser (`9fe8c2a`): the socket takeover and backoff above; `synced_at` no
  longer advances from realtime before a catch-up (the delta skipped what it missed); a held
  document re-delivered as `added` now updates the collection.
- IndexedDB pages from an index on `[collection, sort key, id]` (`0240e29`): 0.6ms instead of
  84ms per page of 30 among 20k messages in Chrome; `total` from a per-collection count.
- Deltas read from `synced_at - syncOverlap` (10s) with `gte` (`a2b5c7e`); the sync now goes
  through the offline switch. Mongo sync versions come from the DB clock, `$$NOW` (`811c5d7`).
  Left: commit order is only covered by the overlap window; the chat demo's custom routes still
  stamp `Date.now()`.
- The chat demo is a PWA on `useCollection` / `useDocument` only (`c44c662`), 45/45 browser checks
  including a real network cut, deployed at https://livequery-chat.global.flygo.vn.

Correctness fixes (2026-09-24): server-side write conflicts with If-Match / 409 (`23f492f`),
versions in commit order via `withVersion` (`1915789`), write-ahead intents so a crash between a
document and its outbox entry loses nothing (`4dd4083`), gateway replay of missed changes
(`4e56527`), no stale frame replay in `Socket` (`f405fb8`), local sort order = MongoDB's
(`1180522`).

## `@livequery/client` write path

Found 2026-09-23 reading the client against the server packages. The read path (one transporter
stream carrying the HTTP result then realtime deltas, storage warmed in every mode) is sound;
everything below is on the write side. Items 1, 2, 3 and 5 are **fixed on `worktree-offline-first`**;
items 4 and 6 stay open.

### 1. ✅ The client sends `id` in the write body, so any strict schema answers 400

**Fixed (branch `worktree-offline-first`):** `RestTransporter` drops `id` from add/update bodies,
and the client itself sends only editable fields. Guarded by `tests/client-strict-schema.e2e.test.ts`
and the Hono + Mongo fullstack suite, which now runs behind `validator(z.strictObject(...))`.

`RestTransporter.#stripPrivateFields` (`packages/rest/src/RestTransporter.ts:328`) drops keys
starting with `_`, and `id` is not one. So `add()` POSTs `{ id: "local:01H...", ... }` and `update()`
PATCHes the same.

The server defends against a client id one layer too late: `D1Datasource.add` discards it with
`const { id: _clientId, ...rest } = body`, but `validator()` runs first and `z.strictObject`
rejects the unknown key outright — 400 `VALIDATION_FAILED`. **Both shipped examples (`cf-worker`,
`todo-mongodb`) use `z.strictObject`**, so `@livequery/client` cannot talk to the setup this repo
recommends.

Fix: strip `id` in the transporter's write body (the server assigns it anyway, and `D1Datasource`
already says so in a comment). Then add an e2e with a validated route — see the blind spot below.

**Why no test caught it:** `tests/helpers/servers.ts` never calls `validator()`. The client suite
does exercise `col.add(...)` against a real Hono server (`tests/helpers/client-suite.ts:93`), but
against an unvalidated route, so the extra key sails through. Any client/server contract test is
worthless until at least one of these servers validates.

### 2. ✅ A realtime event clobbers an in-flight local edit

**Fixed (branch `worktree-offline-first`):** every remote change goes through
`#ingestRemoteChange`, which rebases documents with unconfirmed edits (edited fields keep the local
value until confirmed); `conflictResolver` is now a client option. Confirmation clears only the
`_prev` keys whose value is still the one sent.

`LivequeryCollection` applies a `modified` event as `target.next({ ...target.value, ...data })`,
and when the push resolves `#push` clears `_prev` and `_updating`. So a server-originated update
that lands mid-flight overwrites the user's pending edit and then loses the marker that anything
was pending. A classic lost update, silent.

`ConflictResolverFunction` is exported from `LivequeryClient.ts:29` but wired to nothing — the
README already admits this at line 1151. Until something consumes it, `local-first` is not safe for
data that two people edit at once.

### 3. ✅ The `#adding` lock breaks under concurrent adds

**Fixed (branch `worktree-offline-first`):** refcounted `helpers/AddLock.ts`.

`#push` stores the lock keyed only by `collection_ref`:

```
A: #adding.set(ref, oA)
B: #adding.set(ref, oB)      // overwrites oA
A done: #adding.delete(ref)  // deletes B's lock
```

After that, realtime `added` events stop being deferred while B is still in flight — which is the
duplicate-insert the lock exists to prevent. Not theoretical: `#push` runs `Promise.all` over the
documents, so a single `col.add([doc1, doc2])` hits it. The lock needs to be per-document, or
refcounted per collection.

### 4. A server-first add does not appear until realtime delivers it

The server-first branch of `add()` skips `storage.add`, yet `#push` still calls
`storage.update(ref, 'local:...')` on a record that was never created — memory storage returns
`null` — and broadcasts a `modified` for an id the collection does not hold, which no-ops. The row
only shows up when the server's `added` event arrives. Correct for server-first semantics, but with
no WebSocket connected the item a user just created is invisible until the next query. Either write
it to storage under the server id, or document that server-first requires realtime.

### 5. ✅ `_prev` holds the new values on a server-first update

**Fixed (branch `worktree-offline-first`):** server-first updates no longer build `_prev` at all
(they send the editable fields directly); local-first `_prev` holds pre-edit values, never `id`.

`update()` builds `{ ...doc, _prev: doc }` (`LivequeryClient.ts:508`), while everywhere else —
and the README — `_prev` means the values from *before* the edit. It works only because the
consumer reads `Object.keys(_prev)` as a changed-field set. It is also how `id` ends up in the
PATCH body, so fixing item 1 should fix this too.

### 6. `LivequeryStorge.ts` is a typo re-export in the public API

Two lines, re-exporting `LivequeryStorage` plus a misspelled `LivequeryStorge` alias, and
`index.ts` exports both. 3.0.0 is the release to drop it.
