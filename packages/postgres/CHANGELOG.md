# Changelog — @livequery/postgres

## Unreleased

No changes yet.

## 3.0.0

### Breaking
- `@livequery/core` `^3.0.0` and `rxjs` `^7.8.1` are now peer dependencies (`pg` `^8` stays an
  optional peer). The package imports `@livequery/core` at runtime (`resolveClientId`,
  `ID_ALREADY_EXISTS`); 2.x only used its types.
- POST bodies and `id`: 2.x inserted any body `id` into the key column (`idField`). Now a uuidv7
  `id` is inserted, a legacy `local:` id is ignored (the database assigns the key), and any other
  `id` answers 400 `INVALID_ID`. With `clientIds: false` the body `id` is always ignored.
- Client ids are on by default (`RouteOptions.clientIds`). The 3.x client sends a uuidv7 with
  every add, so a table whose key is `serial` / `bigint` answers 400 `INVALID_ID` ("set
  clientIds: false on this route") until the route sets `clientIds: false` (`61e3aed`).

### Added
- `RouteOptions.clientIds` (default `true`): exactly-once adds. A retried add reuses its id and a
  duplicate primary key answers 409 `ID_ALREADY_EXISTS`; another unique constraint answers 409
  `DUPLICATE_KEY` (Postgres `23505`).

### Changed
- `Cursor.caculate` returns `string` (was `string | null`).
- Repository moved into the livequery monorepo (`packages/postgres`); no other API change.

Migrating from 2.x: see [MIGRATION.md](../../MIGRATION.md).

## 2.x
Released from the pre-monorepo repositories; no changelog was kept.
