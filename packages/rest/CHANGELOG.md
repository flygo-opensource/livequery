# Changelog — @livequery/rest

## Unreleased

### Added
- `RestTransporterConfig.debug`: `true` logs every HTTP call to `console.debug`. A function instead receives each call's `RestTransporterDebugEntry` (`{ method, url, headers, status?, error?, ms }`). This is useful for a client running in a SharedWorker, whose requests do not show up in the page's devtools.

### Changed
- Passes the server's `sync` flag through as `LivequeryQueryResult.sync` (`LivequeryCollectionResponse.sync`).

## 3.0.0

### Breaking
- `@livequery/client` `^3.0.0` is now a peer dependency (2.x had none). Upgrade `@livequery/client` and `@livequery/rest` together.
- `update()` sends an `If-Match: <version>` header when the client passes `options.if_version`, which local-first updates do. A gateway or API on another origin must allow `if-match` in its CORS preflight, next to `socket_id`, `x-lcid` and `x-lgid` (those three are sent as in 2.x). If it does not, the browser blocks these writes. See `LIVEQUERY_CORS_HEADERS` in `@livequery/core`.

### Added
- `read({ ref, filters, headers, context })`: a single read with no realtime subscription. Local-first sync uses it for pages and deltas (3c28278).
- `status$`: socket connection state (`{ connected }`), defined only when `ws` is configured. The client drains its outbox and refetches when it reconnects (39ff8c6).
- `update(collection_ref, id, data, context?, options?: LivequeryWriteOptions)`: sends `options.if_version` as `If-Match` (23f492f).
- Errors from non-2xx responses carry the HTTP `status` (b97208a).
- `LIVEQUERY_PING_FRAME` export (`{"event":"ping"}`).

### Changed
- Write bodies: `add()` sends the client-chosen uuidv7 `id`, but never a legacy `local:` id. `update()` never sends `id`, because it is already in the URL. In 2.x both sent the document's `id` (b97208a, 61e3aed).
- The keep-alive ping is sent as the exact string `{"event":"ping"}`, never msgpack-encoded, so a Cloudflare Durable Object's `setWebSocketAutoResponse` can answer it without waking the object (85d7a8c).

### Fixed
- Reconnect backoff resets once a connection opens. Before, after a few drops the socket waited 30s before each retry (9fe8c2a).
- A reconnect no longer replays frames from earlier connections. Frames sent while disconnected go out once on the next open, and an `unsubscribe` for a ref that is listened to again is dropped (f405fb8).

Migrating from 2.x: see [MIGRATION.md](../../MIGRATION.md).

## 2.x
Released from the pre-monorepo repositories; no changelog was kept.
