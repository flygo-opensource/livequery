# Changelog — @livequery/d1

## Unreleased

No changes yet.

## 3.0.1

### Added
- Client ids: a uuidv7 `id` in a POST body becomes the row `id`, so an add retried after a lost
  response cannot create a second row. `D1RouteOptions.clientIds` / `d1({ clientIds })`, default
  `true`; `false` always assigns `crypto.randomUUID()` as in 3.0.0 (`61e3aed`).
- A duplicate `id` answers 409 `ID_ALREADY_EXISTS`; another `UNIQUE` constraint answers 409
  `DUPLICATE_KEY` (3.0.0 rethrew the raw D1 error).

### Changed
- A POST body `id` that is neither a uuidv7 nor a legacy `local:` id now answers 400
  `INVALID_ID` (3.0.0 ignored any body `id`). `clientIds: false` restores the 3.0.0 behaviour.
- README: `@livequery/core/node` and `/bun` no longer load UDP discovery (removed from core).

## 3.0.0

Initial release: a Cloudflare D1 datasource for Livequery.

### Added
- `D1Datasource`, which implements `LivequeryDatasource<D1RouteOptions>`: `init(routes)`,
  `handle(ctx)`, `query(req, options)`. There are also overloads that take a D1 binding
  directly (`handle(db, req, options)`, `query(db, req, options)`, `add` / `update` / `delete`)
  for Workers that get `env.DB` per request.
- `D1DatasourceConfig.databases` (named bindings); `D1RouteOptions`: `table`, `database`
  (name or `(req) => name`), `realtime`, `fields`.
- `d1(options)`: Hono middleware (`validator(Task), livequery(), d1(), realtime()`). It picks the
  operation from the method and ref (POST answers 201), resolves the binding from `env.DB`
  (`binding`) and the table from the collection ref (`table`). Columns come from the route's
  `validator()` schema or `fields`. It publishes `livequery_result` and builds the response
  before `next()` (`20d5716`).
- Column safety: every identifier that reaches SQL (filter/sort/body/route keys, table) must match
  `IDENTIFIER_PATTERN` (`^[A-Za-z_][A-Za-z0-9_]{0,63}$`) or it gets 400 `INVALID_FIELD`. `fields`
  is an allowlist (400 `FIELD_NOT_ALLOWED`; `id` and route keys are always allowed). Exported as
  `assertColumn()` / `assertTable()` (`7e9385a`).
- Unknown filter operators answer 400 `INVALID_OPERATOR`. `in` / `nin` take at most
  `MAX_IN_VALUES` (50) values (400 `TOO_MANY_VALUES`), which keeps a statement under D1's
  100-parameter limit.
- `D1Query`, `Cursor` (cursor paging, 400 `INVALID_CURSOR`), and the types `D1CollectionResult`,
  `D1DocumentResult`, `QueryPlan`, `D1MiddlewareOptions`.
- Imports only the runtime-neutral root of `@livequery/core`, so it needs no `nodejs_compat`.
  Peer dependencies: `@livequery/core` `^3.0.0`, `@cloudflare/workers-types` `^4`.

## 2.x
Not published; `@livequery/d1` is new in 3.x.
