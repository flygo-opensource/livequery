# Changelog — @livequery/rpc

## 3.0.1

### Changed
- No code changes. Released with `@livequery/client` 3.0.1, which fixes local-first deltas and `update()` with a snapshot of the document.

## 3.0.0

Released with the rest of the 3.0.0 packages. The public API (exports, signatures, entry points, dependencies) is unchanged from 2.0.155.

### Breaking
- None.

### Fixed
- `SharedWorkerChannel` releases a tab's streams when its port fires `close` (Chrome 122+). Before, they stayed open in the worker for the worker's whole lifetime (ebf791a).

### Changed
- README: create the worker with `new SharedWorker(url, { extendedLifetime: true })`, so it is not stopped, and its sockets not closed (1006), while the only tab reloads (69afde6).
- Package metadata (repository, homepage, bugs) now points at the monorepo.

Migrating from 2.x: see [MIGRATION.md](../../MIGRATION.md).

## 2.x
Released from the pre-monorepo repositories; no changelog was kept.
