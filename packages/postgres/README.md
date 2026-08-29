# @livequery/postgres

Native PostgreSQL datasource adapter for the `@livequery` ecosystem.

This package translates Livequery request shapes into parameterized SQL against plain
PostgreSQL tables. It is the Postgres counterpart of `@livequery/mongodb`: same
`LivequeryDatasource` contract, same request/response shapes, so the two backends are
interchangeable from `@livequery/core`'s point of view.

It is intended for projects that want to use `@livequery/core` with raw SQL tables,
without an ORM. There is no schema introspection, no models, no migrations — you give it
a `pg.Pool` (or anything exposing `query(text, values)`), tell each route which table to
hit, and it runs the corresponding SQL.

Reads are executed as a single windowed `SELECT` plus a `COUNT(...) FILTER (...)` for
pagination metadata. Writes use `INSERT` / `UPDATE` / `DELETE ... RETURNING *`.

## Installation

```sh
bun add @livequery/postgres pg rxjs
```

`pg` is an **optional peer dependency** — any object with a node-postgres-shaped
`query(text, values) => { rows }` works, so you can also drive it with a pool from another
library. The adapter never imports from `pg` directly.

## Exports

```ts
export * from './PostgresDatasource.js'
export * from './PostgresQuery.js'
export * from './Cursor.js'
export * from './SmartCache.js'
export * from './Sql.js'
export * from './DataChangePayload.js'
export * from './PostgresRealtime.js'
```

## How it maps to MongoDB

| MongoDB adapter            | Postgres adapter              |
| -------------------------- | ----------------------------- |
| `collection`               | `table`                       |
| `db` (database)            | `schema` (Postgres schema)    |
| `_id` (ObjectId)           | `idField` column (default `id`) |
| `objectIdFields`           | — (not needed; ids are plain text/uuid) |
| aggregation pipeline       | `SELECT` + `WHERE` + `ORDER BY` |
| `$facet` cursor paging     | keyset (`WHERE (a,b) > (..)`) + `COUNT FILTER` |
| change streams             | `LISTEN` / `NOTIFY` triggers  |
| `field:eq-oid`             | treated as plain `field:eq`   |

Everything else — filter suffixes, `:sort`, `:limit`, `:after`/`:before`/`:around`,
`:page`, `:search`, `::summary`, the cursor encoding, and all response shapes — behaves
the same as the MongoDB adapter.

## Configuration Types

### `PostgresDatasourceConfig`

```ts
import type { Pool } from 'pg'

type PostgresDatasourceConfig = {
  connections: { [key: string]: Pool }   // or any { query(text, values) } executor
  schemas?: string[]                      // metadata for the realtime watcher
}
```

Default resolution:

- Connection defaults to the first configured connection name, then `"default"`.
- Schema defaults to route `schema`, then `process.env.PG_SCHEMA`, then `"public"`.

### `RouteOptions`

```ts
type RouteOptions = {
  realtime?: boolean
  table: string | ((req: LivequeryRequest) => Promise<string> | string)
  schema?: string | ((req: LivequeryRequest) => Promise<string> | string)
  connection?: string | ((req: LivequeryRequest) => Promise<string> | string)
  idField?: string        // physical primary key column exposed to clients as `id` (default 'id')
  searchFields?: string[] // columns scanned by `:search`
}
```

- `table` is required and may be a string or a resolver function.
- `idField` lets you back a table whose primary key is `user_id`, `uuid`, etc. The adapter
  renames it to `id` on the way out and maps `keys.id` onto it on the way in.
- `searchFields` enables `:search=foo` → `(col1::text ILIKE %foo% OR col2::text ILIKE %foo%)`.

## Core Usage Example

```ts
import { Pool } from 'pg'
import { LivequeryRequestParser, type LivequeryContext } from '@livequery/core'
import { PostgresDatasource } from '@livequery/postgres'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

const datasource = new PostgresDatasource({
  connections: { default: pool },
})

await datasource.init([
  { method: 'GET', path: '/products', table: 'products', searchFields: ['name'] },
  { method: 'GET', path: '/products/:id', table: 'products' },
])

const ctx: LivequeryContext = {
  request: {
    method: 'GET',
    path: '/products',
    ref: '/products',
    params: {},
    query: { ':limit': 20, 'price:sort': 'desc', 'price:gte': 10 },
    headers: new Map(),
  },
}

new LivequeryRequestParser().handle(ctx)
await datasource.handle(ctx)

console.log(ctx.response.items)
```

## Filters

```ts
{
  'status': 'active',         // field = $
  'price:gte': 10,            // field >= $
  'price:lte': 100,           // field <= $
  'tag:in': ['a', 'b'],       // field = ANY($)
  'name:like': 'phone',       // field ILIKE %phone% (wildcards escaped)
  'deleted_at:eq-null': 1,    // field IS NULL
  ':search': 'pho',           // OR over route.searchFields
  ':limit': 20,
  'price:sort': 'asc',
}
```

Supported suffixes: `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `in`, `nin`, `like`,
`eq-number`, `neq-number`, `eq-boolean`, `neq-boolean`, `eq-null`, `neq-null`,
`eq-oid`/`neq-oid` (aliased to plain eq/ne). Logical groups `:and` / `:or` / `:not` nest
recursively.

Dotted field names (`meta.color`) are read as JSONB text paths (`"meta"#>>'{color}'`).
Every identifier is validated against `^[a-zA-Z_][a-zA-Z0-9_]*$` and all values are bound
as `$n` parameters, so user input cannot inject SQL.

## Pagination

- **Cursor** (default, or `:after` / `:before` / `:around`): keyset pagination over the
  sort columns plus `id` as a stable tiebreaker. Cursors are the same hex-encoded JSON the
  MongoDB adapter emits.
- **Offset** (`:page=N`, when no cursor token is present): `LIMIT/OFFSET` plus a total
  `COUNT`.

`:limit` defaults to `10`, min `1`, max `100`.

## Summary

```ts
{
  'category:sort': 'asc',
  '::totals': 'sum(price)|avg(price)|count()',  // scalar(s) or grouped rows
  '::byCat': 'category|sum(price)',             // GROUP BY category, up to 50 rows
}
```

`sum` / `avg` / `min` / `max` accept an arithmetic expression over columns
(`sum(price*qty)`, `~` rounds). `count()` and `distinct()` map to `count(*)`. A single
aggregate with no grouping yields a scalar; grouped queries yield an array of rows.

## Writes

```ts
// POST  -> INSERT INTO t (cols...) VALUES (...) RETURNING *
// PUT/PATCH plain body -> UPDATE t SET col = $ ... WHERE <keys> RETURNING *
// PATCH operator body  -> $set / $inc / $dec / $mul / $unset translated to SQL
// DELETE -> DELETE FROM t WHERE <keys> RETURNING *
```

Because writes use `RETURNING *`, the response `item` is the real row (unlike the MongoDB
adapter, which reconstructs it from the request). If `RETURNING` yields nothing, it falls
back to the `{ id, ...body }` shape.

## Realtime (`LISTEN` / `NOTIFY`)

`PostgresRealtime` is the Postgres equivalent of `MongodbRealtime`. It listens on a NOTIFY
channel fed by a small generic trigger and formats the same nested-ref Livequery payloads.

```ts
import { Client } from 'pg'
import { WebsocketGateway } from '@livequery/core'
import { PostgresRealtime } from '@livequery/postgres'

// 1. Install the trigger once (per watched table):
await pool.query(PostgresRealtime.triggerSql(['products', 'posts'], 'livequery'))

// 2. Pass a FACTORY that returns a fresh, connected, DEDICATED client. The factory is
//    called again on every reconnect, so a dropped connection self-heals.
const connect = async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL })
  await c.connect()
  return c
}

const websocketGateway = new WebsocketGateway(server)

new PostgresRealtime({ channel: 'livequery', reconnectDelayMs: 1000 })
  .watch(connect, [
    { schema: 'products', options: { table: 'products', realtime: true } },
    { schema: 'users/:user_id/posts', options: { table: 'posts', realtime: true } },
  ])
  .subscribe(websocketGateway)
```

Notes:

- `watch(source, routes)` accepts either a connected `pg.Client` or a **factory**
  `() => Promise<Client>`. Use the factory for **automatic reconnection** — `watch()` retries
  with exponential backoff (`reconnectDelayMs` base, `maxReconnectDelayMs` cap) and a single
  client cannot be reused once it has errored. A connection it created is closed on
  unsubscribe; a client you passed directly is left for you to manage.
- Use a dedicated client for `LISTEN` — a `Pool` hands out a different physical connection
  per query, so notifications would be missed.
- A NOTIFY payload is capped at 8000 bytes. For wide rows, prefer logical replication
  (wal2json / pgoutput) and feed `PostgresRealtime` with your own decoder, or notify only
  the columns you watch.
- For nested refs, name each route param after the document column holding the parent
  value (`users/:user_id/posts` reads `user_id`). Array columns fan out one ref per element.

## Build And Verification

```sh
bun install
npm run build
npm test
```

`npm test` runs the Bun test suite against a mocked `pg` client, so it needs no real
PostgreSQL server.

## Notes

- ESM, TypeScript `NodeNext`. Local imports use `.js` extensions.
- Do not add an ORM dependency here. Keep this adapter raw-SQL.
- `@livequery/core` is used for types and core handler integration only.
