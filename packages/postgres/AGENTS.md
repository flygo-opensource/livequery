# Agent Notes For @livequery/postgres

This package is a TypeScript ESM datasource adapter between `@livequery/core` request
shapes and raw PostgreSQL tables (via a node-postgres-shaped `query(text, values)`
executor). It is the Postgres counterpart of `@livequery/mongodb` and intentionally mirrors
its public contract so the two backends are interchangeable.

Use this document when an agent needs to inspect, edit, or extend the package.

## Project Meaning

`@livequery/postgres` receives parsed Livequery requests, decides which Postgres table
should handle them, and executes parameterized SQL. It deliberately does not use an ORM.
No schemas, models, migrations, validation, hooks, or joins/`populate()`.

## Architecture

- `src/index.ts`: public exports.
- `src/PostgresDatasource.ts`: main datasource adapter. `init(routes)`, `handle(ctx)`,
  `query(req, options)`, and the write paths (`INSERT`/`UPDATE`/`DELETE ... RETURNING *`).
- `src/PostgresQuery.ts`: static read query builder. Translates filters, sorting, cursor +
  offset paging, and `::summary` aggregates into SQL. The heart of the package.
- `src/Sql.ts`: `PgQueryable` interface, the `Sql` positional-parameter builder, and the
  `ident` / `qualifiedTable` / `escapeLike` identifier-safety helpers.
- `src/Cursor.ts`: cursor encode/decode helper (identical to the mongo adapter; cursors are
  backend-agnostic hex-encoded JSON).
- `src/SmartCache.ts`: promise cache for resolved table descriptors.
- `src/DataChangePayload.ts`: type-only realtime/change payload contract.
- `src/PostgresRealtime.ts`: `LISTEN`/`NOTIFY` watcher that formats Livequery sync payloads.

## Contract parity with @livequery/mongodb

Keep these identical to the mongo adapter unless asked for a breaking change:

- `class PostgresDatasource extends Subject<UpdatedData<...>> implements CoreLivequeryDatasource<RouteOptions>`.
- `init(routes)`, `handle(ctx)`, `query(req, options)` — same signatures and error codes
  (`INVALID_LIVEQUERY_REQUEST` 400, `ROUTE_OPTIONS_NOT_FOUND` 404, `DB_CONFIG_NOT_FOUND` 500,
  `DB_CONNECTION_NOT_FOUND` 500, `INVAILD_METHOD` 500 — note the legacy spelling).
- Route lookup stores both `METHOD path` and a path-only fallback; the table-mismatch guard
  throws on conflicting `table` for the same path.
- `#get` response shapes (collection + document) are copied verbatim from the mongo adapter
  so `Paging` / `items` / `summary` / `item` match exactly.

## Naming map (mongo -> postgres)

| mongo            | postgres                          |
| ---------------- | --------------------------------- |
| `collection`     | `table`                           |
| `db`             | `schema`                          |
| `_id` ObjectId   | `idField` column (default `id`)   |
| `objectIdFields` | removed                           |
| `databases`      | `schemas`                         |
| `eq-oid`/`neq-oid` | aliased to `eq`/`ne`            |

## Safety rules (do not regress)

- All values flow through `Sql.param()` → `$n` placeholders. Never interpolate a value into
  SQL text.
- All identifiers (columns/tables/schemas) go through `ident()` / `qualifiedTable()`, which
  validate each segment against `^[a-zA-Z_][a-zA-Z0-9_]*$` and throw `INVALID_FIELD` (400).
  Never interpolate a raw field name.
- `LIMIT` / `OFFSET` are built from numbers that are clamped/floored, not from raw input.

## Read query builder (`PostgresQuery.query`)

- `:limit` defaults to `10`, min `1`, max `100`.
- Sort: `field:sort=asc|desc`; `id` is always appended as the final tiebreaker (default
  `DESC`, matching mongo's `_id: -1`) so the keyset is stable.
- Cursor paging (default, `:after`, `:before`, `:around`): keyset comparison expanded to
  OR-of-AND form so mixed sort directions work. `count.prev` / `count.next` come from one
  `COUNT(*) FILTER (...)` over the filter, relative to the first/last item of the window.
- Offset paging (`:page`, only when no cursor token): `LIMIT/OFFSET` + a total `COUNT`.
  `count.prev = skip`, `count.next = max(total - skip - limit, 0)` (mongo-equivalent).
- Summary (`::name`): `sum/avg/min/max(expr)` over arithmetic columns, `count()`/`distinct()`
  → `count(*)`. Single agg + no group → scalar; grouped → array (capped `LIMIT 50`). Inline
  `field==v` style matches are AND'd onto the base filter.
- `idField` rename: physical PK column is exposed to clients as `id` on read; `keys.id` maps
  onto it on write.

## Writes (`PostgresDatasource`)

- `post`: `INSERT INTO t (cols) VALUES (...) RETURNING *` (or `DEFAULT VALUES` when empty).
- `put`/`patch`: `UPDATE t SET ... WHERE <keys> RETURNING *`. Plain body → `col = $`. Operator
  body → `$set` / `$inc` / `$dec` / `$mul` / `$unset`.
- `delete`: `DELETE FROM t WHERE <keys> RETURNING *`.
- All return `{ item: <returned row mapped to id> }`, falling back to `#writtenItem(req)` when
  `RETURNING` is empty.

## Realtime (`PostgresRealtime`)

- `watch(source, routes)` where `source` is either a dedicated connected `pg.Client`-like
  (`.on('notification'|'error', ...)`, `.query`, optional `.end`) OR a **factory**
  `() => Promise<conn>`. NOT a pool.
- Auto-reconnect: `watch()` pipes the raw change source through rxjs `retry()` with
  exponential backoff (`reconnectDelayMs` base, `maxReconnectDelayMs` cap). A dropped
  connection surfaces via the client `error` event → `observer.error` → retry resubscribes
  → the factory yields a fresh connection. A single client can't reconnect (use a factory).
  Connections the watcher creates (factory form) are `end()`-ed on teardown; caller-supplied
  clients are only `UNLISTEN`-ed.
- `PostgresRealtime.triggerSql(tables, channel)` returns SQL to install a generic NOTIFY
  trigger publishing `{ table, type, old_data, new_data }`.
- Ref fan-out logic (`#paths` / `#routeRefMetadata` / `#format`) is ported from the mongo
  adapter; only the event source differs. `:param` reads the column of the same name (`id`
  maps to `idField`); array columns fan out per element.
- Verified end-to-end against real Postgres via `tests/live-realtime.ts` (added/modified/
  removed, nested ref, array fan-out, and reconnect after `pg_terminate_backend`).

## Build And Verification

```sh
bun install
npm run build   # tsc -b .
npm test        # bun test, mocked pg client
```

- ESM, `NodeNext`, local imports use `.js` extensions.
- `tsconfig.json` keeps `"types": ["node"]`; the source never imports from `pg`, so the build
  does not require `@types/pg`.
- Do not add an ORM. Keep it raw SQL.
- Do not reintroduce `@livequery/types`; use `@livequery/core` for core-facing types.
