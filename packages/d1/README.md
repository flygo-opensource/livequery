# `@livequery/d1`

Cloudflare D1 datasource adapter for Livequery.

## Hono middleware

```ts
import { d1 } from '@livequery/d1'

app.get('/livequery/tasks', validator(Task), livequery(), d1(), realtime())
```

`d1()` picks the operation from the method and the ref: a collection GET lists, a document GET
reads, POST inserts (201), PUT/PATCH update, DELETE removes. It resolves the binding from
`env.DB` (override with `d1({ binding: 'TASKS_DB' })`) and the table from the collection ref
(override with `d1({ table })`). Columns come from the route's `validator()` schema, or from
`d1({ fields })`.

The result is published as `livequery_result`, the response is built, and then the rest of the
chain runs — so `realtime()` and any other trailing middleware see the result and can add
headers. A failing query throws a normalized error, so nothing downstream publishes a change
that never happened.

## Core datasource integration

```ts
import { D1Datasource } from '@livequery/d1'

const datasource = new D1Datasource({
  databases: { default: env.DB },
})

const products = { table: 'products', fields: ['name', 'price', 'created_at'] }

await datasource.init([
  { method: 'GET', path: '/livequery/products', ...products },
  { method: 'GET', path: '/livequery/products/:id', ...products },
  { method: 'POST', path: '/livequery/products', ...products },
])

// After LivequeryRequestParser has populated context.livequery:
const response = await datasource.handle(context)
```

`D1Datasource` implements `LivequeryDatasource<D1RouteOptions>`. A route can select
one of several configured bindings with `database`, including a request-based resolver:

```ts
const datasource = new D1Datasource({
  databases: { primary: env.DB, tenant: env.TENANT_DB },
})

await datasource.init([{
  method: 'GET',
  path: '/livequery/:tenant/products',
  table: 'products',
  database: request => request.keys.tenant === 'special' ? 'tenant' : 'primary',
}])
```

## Per-request Worker binding

When the D1 binding is only available from a Worker's request `env`, the original
direct API remains available:

```ts
const datasource = new D1Datasource()

const result = await datasource.handle(
  env.DB,
  livequeryRequest,
  { table: 'products' },
)
```

## Column safety

D1 binds values, not identifiers, so table and column names end up in the SQL text.
Every name that reaches SQL (filter keys, `:sort` keys, body keys, route keys, the
table) must match `^[A-Za-z_][A-Za-z0-9_]{0,63}$`; anything else is rejected with
`400 INVALID_FIELD` before a statement is prepared. A bad table name is a programming
error and throws `Error`.

Set `fields` on each route to the columns clients may filter, sort and write. Other
columns are rejected with `400 FIELD_NOT_ALLOWED`. `id` and route keys (such as
`:tenant_id` in the path) are always allowed. Without `fields`, any well-formed column
of the table can be filtered and written, so leave it unset only when every column is
safe to expose.

Other limits enforced before querying:

- Unknown filter operators (`field:regex`) return `400 INVALID_OPERATOR` instead of being
  ignored.
- `in` / `nin` accept at most `MAX_IN_VALUES` (50) values, keeping a statement under D1's
  100 bound-parameter limit (`400 TOO_MANY_VALUES`).

## Edge runtime

The package imports only the runtime-neutral root of `@livequery/core`, so a Worker
bundle that uses it needs no `nodejs_compat` flag. In a Worker, import from
`@livequery/core` or `@livequery/core/workers`, never from `@livequery/core/node` or
`@livequery/core/bun`, which load `ws`, `http` and UDP discovery.
