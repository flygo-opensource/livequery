# Changelog — @livequery/mongodb

## 3.0.1

### Breaking (vs 3.0.0)
- `RouteOptions.clientIds` / `mongodb({ clientIds })` now defaults to on only for `sync: true`
  routes. Other routes ignore the client's uuidv7 and MongoDB assigns an ObjectId, as in 2.x
  (3.0.0 stored BSON UUID `_id`s on every route). `clientIds: true` / `false` still override
  (`21eee80`). A collection served by 3.0.0 may hold UUID `_id`s already:
  `db.coll.find({ _id: { $type: 'binData' } })`.

### Added
- Reads on a `sync` route answer `sync: true` next to `items` / `item`. The client reads deltas
  only when it sees this flag (`3a7b2c4`).

## 3.0.0

### Breaking
- `@livequery/core` `^3.0.0` and `rxjs` `^7.8.1` are now peer dependencies next to `mongodb`
  `^6.20.0`. The package imports `@livequery/core` at runtime (`resolveClientId`,
  `ID_ALREADY_EXISTS`, `toLivequeryError`); 2.x only used its types.
- Client ids: a uuidv7 `id` in a POST body is stored as a BSON UUID `_id` (`Binary` subtype 4) on
  every route by default (`61e3aed`; narrowed to sync routes in 3.0.1). Responses, realtime
  payloads and cursors expose it as the dashed uuid string, so an `id` is no longer always 24 hex.
  A body `id` that is neither a uuidv7 nor a legacy `local:` id answers 400 `INVALID_ID` (2.x
  dropped any body `id`). `clientIds: false` restores the 2.x behaviour.
- `MongodbRealtime`: an update that moves a document between parent refs is now reported as
  `removed` under the old ref and `added` (with the full document) under the new one;
  `modified` only for a parent it stayed in. 2.x sent `modified` to every affected ref (`5d9eb88`).

### Added
- `mongodb(options)`: Hono-shaped datasource middleware, the MongoDB twin of `d1()`. Options:
  `connection` (`Db`, or `MongoClient` + `db`), `db`, `collection`, `objectIdFields`, `fields`,
  `clientIds`, `sync`. The route's `validator()` schema is the allowlist of queryable fields
  (400 `FIELD_NOT_ALLOWED`); it builds the response before `next()`, so `realtime()` can follow
  (`70a7529`).
- `RouteOptions.clientIds`: exactly-once adds. A duplicate `_id` answers 409 `ID_ALREADY_EXISTS`,
  another unique index 409 `DUPLICATE_KEY`; a uuidv7 more than a day in the future is 400
  `INVALID_ID`. `GET/PATCH/DELETE /:id` accept an ObjectId (24 hex) or a uuid.
- `toMongoId(field, value)` / `fromMongoId(value)` helpers (ObjectId or BSON UUID <-> string).
- `RouteOptions.sync` / `mongodb({ sync: true })` for local-first clients (`5df5c63`, `811c5d7`,
  `1915789`):
  - every write stamps `updated_at` with the collection's next version,
    `max(database clock ms, previous + 1)`, allocated in commit order inside a transaction on a
    per-collection counter (`__livequery_versions`). Needs a replica set; a standalone server
    warns once and versions follow allocation order;
  - a delete keeps a tombstone (`deleted_at` + `updated_at`); updates never touch a tombstone;
  - reads hide tombstones unless the query has `:tombstones=1` (delta reads:
    `updated_at:gte=<v>&updated_at:sort=asc&:tombstones=1`); realtime sends a delete as
    `modified` with `deleted_at`;
  - `updated_at` / `deleted_at` stay queryable under a field allowlist.
- `If-Match: <version>` on a PATCH to a sync route (read by `mongodb()` into
  `LivequeryRequest.if_version`) only applies to that version; otherwise 409 `VERSION_CONFLICT`
  (exported constant). A refused write spends no version (`23f492f`).
- `withVersion(db, collection, (version, session) => ...)`: run hand-written writes to a sync
  collection with a version in commit order.
- `MongodbRealtime` options `reconnectDelayMs` (1000), `maxReconnectDelayMs` (30000) and
  `onError(error, { stage: 'collMod' | 'watch', collection?, attempt? })`; type
  `MongoRealtimeFailure`.

### Fixed
- `MongodbRealtime`: a failed `collMod` (e.g. a `readWrite`-only user) no longer spins the CPU
  through a bare `retry()`. The failure is reported once per collection and not re-issued, the
  watcher starts anyway (deletes then carry only the document id), and a dropped stream
  resubscribes with exponential backoff. Failures go to `onError`, else `console.error`
  (`d61fae3`).
- `mongodb()`: a client body can no longer carry MongoDB operators (`$unset`, `$rename`, ...) or
  dotted paths (400 `INVALID_BODY`), nor, with an allowlist, fields outside it (400
  `FIELD_NOT_ALLOWED`). Server code calling `MongoDatasource.query` directly keeps operator
  bodies (`ca37eea`).
- Cursor paging crosses the ObjectId/UUID boundary in a collection holding both kinds of `_id`
  (`$lt`/`$gt` alone match one BSON type only).
- `Cursor.caculate` returns `string` (was `string | null`).

Migrating from 2.x: see [MIGRATION.md](../../MIGRATION.md).

## 2.x
Released from the pre-monorepo repositories; no changelog was kept.
