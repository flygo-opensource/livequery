# @livequery/mongodb

Native MongoDB datasource adapter for the `@livequery` ecosystem.

This package translates Livequery request shapes into MongoDB native driver operations. It is intended for projects that want to use `@livequery/core` with plain `mongodb` collections, without Mongoose models or schema introspection.

The adapter supports two integration styles:

- Core style: `new MongoDatasource(config)`, `init(routes)`, then `handle(ctx)`.
- Legacy style: `new MongoDatasource()`, `init(config, routes)`, then direct `query(req, options)`.

Reads are executed with MongoDB aggregation pipelines through `Collection.aggregate(...).toArray()`. Writes use native collection methods such as `insertOne`, `updateOne`, and `deleteOne`.

## Installation

```sh
bun add @livequery/mongodb mongodb bson rxjs
```

For local development in this workspace, `@livequery/core` is installed as a dev dependency from `file:../core`. Runtime JavaScript does not import `@livequery/core`; the generated declaration files use core types.

## Exports

```ts
export * from './MongoDatasource.js'
export * from './DataChangePayload.js'
export * from './MongodbRealtime.js'
export * from './types.js'
```

## Project Meaning

`@livequery/mongodb` is the MongoDB datasource layer for Livequery.

Its job is not to parse HTTP requests. That belongs to `@livequery/core`, usually through `LivequeryRequestParser`. Its job is also not to provide Mongoose-style schemas, validation, hooks, virtuals, or `populate()`. This package receives a parsed Livequery request, resolves which MongoDB collection should handle it, and runs the corresponding native MongoDB operation.

Typical request flow with `@livequery/core`:

1. A framework adapter creates a `LivequeryContext`.
2. `LivequeryRequestParser` reads `ctx.request` and writes `ctx.livequery`.
3. `MongoDatasource.handle(ctx)` resolves route options from `ctx.request.method` and `ctx.request.ref`.
4. `MongoDatasource` converts `ctx.livequery.query` into adapter `req.options`.
5. Reads are delegated to `MongoQuery`; writes go directly to the native collection.
6. The result is assigned to `ctx.response`.

## Main Classes And Types

### `MongoDatasource`

Main adapter class.

```ts
class MongoDatasource extends Subject<WebsocketSyncPayload<LivequeryBaseEntity>>
```

Responsibilities:

- Store datasource config and route options.
- Support core-style and legacy-style initialization.
- Resolve connection, database, and collection for each request.
- Normalize configured ObjectId fields.
- Execute reads, inserts, updates, and deletes.
- Implement `handle(ctx)` for `@livequery/core`.

#### `constructor(config?)`

Creates a datasource.

Parameters:

- `config?: MongoDatasourceConfig`: optional database configuration. Use this for core-style initialization.

Example:

```ts
const datasource = new MongoDatasource({
  connections: { default: client },
  databases: ['main'],
})
```

If `config` is omitted, call `init(config, routes)` later.

#### `init(routes)`

Core-style initialization.

Parameters:

- `routes: Array<LivequeryDatasourceInitConfig<RouteOptions>>`: route entries. Each entry includes `method`, `path`, and route options such as `collection`, `db`, `connection`, and `objectIdFields`.

Example:

```ts
await datasource.init([
  {
    method: 'GET',
    path: '/products',
    collection: 'products',
  },
])
```

Route lookup uses `METHOD path`, for example `GET /products`. A path-only fallback is also stored for compatibility.

#### `init(config, routes)`

Legacy-style initialization.

Parameters:

- `config: MongoDatasourceConfig`: MongoDB connection configuration.
- `routes: Array<{ method; path; options }>`: legacy route entries. The datasource options are nested under `options`.

Example:

```ts
await datasource.init(
  {
    connections: { default: client },
    databases: ['main'],
  },
  [
    {
      method: 'GET',
      path: '/products',
      options: {
        collection: 'products',
      },
    },
  ]
)
```

#### `handle(ctx)`

Core handler entry point.

Parameters:

- `ctx: LivequeryContext`: context created by `@livequery/core` or a framework adapter. `ctx.livequery` must already be populated, usually by `LivequeryRequestParser`.

Behavior:

- Throws `INVALID_LIVEQUERY_REQUEST` if `ctx.livequery` is missing.
- Resolves route options from `ctx.request.method` and `ctx.request.ref || ctx.request.path`.
- Calls `query(req, options)`.
- Assigns the result to `ctx.response`.
- Returns `ctx.response`.

Example:

```ts
new LivequeryRequestParser().handle(ctx)
await datasource.handle(ctx)
console.log(ctx.response)
```

Important: for dynamic routes such as `/products/:id`, `ctx.request.ref` should be the route pattern, not the concrete URL. Example: `ref: '/products/:id'`, `path: '/products/507f1f77bcf86cd799439011'`.

#### `query(req, options)`

Executes a parsed Livequery request against one MongoDB collection.

Parameters:

- `req: LivequeryRequest`: adapter request. Core requests use `query`; this adapter normalizes it to `options`. Legacy callers can pass `options` directly.
- `options: RouteOptions`: route configuration that tells the adapter which collection, database, connection, and ObjectId fields to use.

Supported `req.method` values:

- `get`: read collection or document.
- `post`: insert one document.
- `put`: update one document.
- `patch`: update one document.
- `delete`: delete one document.

Write behavior:

- `post` merges `req.keys` and `req.body`, then calls `insertOne`.
- `put` and `patch` call `updateOne`.
- Plain update bodies are wrapped in `$set`.
- Bodies that already contain MongoDB update operators, such as `$set` or `$inc`, are passed through unchanged.
- `delete` calls `deleteOne`.

Example:

```ts
const response = await datasource.query(
  {
    method: 'get',
    ref: 'products',
    is_collection: true,
    keys: {},
    options: { ':limit': 10 },
  },
  {
    collection: 'products',
  }
)
```

### `MongoQuery`

Static read query builder.

Responsibilities:

- Convert Livequery filters into MongoDB aggregation stages.
- Build sort stages from `field:sort` options.
- Build cursor paging stages from `:after`, `:before`, and `:around`.
- Convert Mongo `_id` into response `id`.
- Parse summary aggregation options beginning with `::`.
- Execute `collection.aggregate(pipeline).toArray()`.

#### `MongoQuery.query(req, collection)`

Parameters:

- `req: LivequeryRequest`: normalized adapter request. Reads `req.keys`, `req.options`, and `req.is_collection`.
- `collection: Collection<T>`: native MongoDB collection.

Behavior:

- For document reads, matches by `req.keys`, converts `req.keys.id` to `_id`, renames `_id` to `id`, and returns a one-item result shape.
- For collection reads, builds an aggregation pipeline with sort, filter, search, id rename, cursor paging, and summary facets.

Known behavior:

- `:limit` defaults to `10`.
- Minimum `:limit` is `1`.
- Maximum `:limit` is `100`.
- Cursor paging is implemented.
- Offset paging with `page` is not implemented yet.

Filter examples:

```ts
{
  'status': 'active',
  'price:gte': 10,
  'price:lte': 100,
  'categoryId:eq-oid': '507f1f77bcf86cd799439011',
  'name:like': 'phone',
  ':limit': 20,
  'price:sort': 'asc',
}
```

Summary example:

```ts
{
  'category:sort': 'asc',
  '::totals': 'category|sum(price)|avg(price)|count()',
}
```

### `Cursor`

Cursor pagination helper.

#### `Cursor.caculate(item, options)`

Builds a cursor from a response item and active sort options.

Parameters:

- `item: LivequeryBaseEntity`: response item. Must contain `id`.
- `options: QueryOption`: request options. Sort options ending with `:sort` are included in the cursor.

Returns:

- Hex-encoded JSON cursor string.
- `null` when `item` is missing.

The method name is intentionally spelled `caculate` for compatibility.

#### `Cursor.parse(cursor)`

Decodes a cursor.

Parameters:

- `cursor: string`: hex-encoded JSON cursor created by `Cursor.caculate`.

Returns:

- Parsed cursor object.
- `null` when the input is empty.

### `SmartCache`

Small async promise cache used for native collection handles.

#### `get(key, resolver)`

Parameters:

- `key: any`: cache key.
- `resolver: () => Promise<T>`: async function used when the key is not already cached.

Returns:

- The cached promise result.

The collection cache key includes connection, database, and collection name to avoid reusing collection handles across tenants or connections.

### `MongodbRealtime`

MongoDB change stream watcher for realtime Livequery updates. This replaces the need to use the separate `@livequery/mongodb-mapper` package in native MongoDB projects.

```ts
import { WebsocketGateway } from '@livequery/core'
import { MongoDatasource, MongodbRealtime } from '@livequery/mongodb'

const datasource = new MongoDatasource({
  connections: { default: client },
  databases: ['main'],
})

await datasource.init([
  {
    method: 'GET',
    path: '/products',
    collection: 'products',
    realtime: true,
  },
])

const websocketGateway = new WebsocketGateway(server)

new MongodbRealtime()
  .watch(datasource.config, [
    {
      // LivequeryRequestParser.parse(...).schema — document-id segment already stripped
      schema: 'products',
      options: { collection: 'products', realtime: true },
    },
  ])
  .subscribe(websocketGateway)
```

`MongoRealtimeRoute`:

```ts
type MongoRealtimeRoute = {
  schema: string        // parsed route path from @livequery/core, e.g. 'users/:userId/posts'
  options: RouteOptions
}
```

Realtime route requirements:

- `realtime` must be `true`.
- `schema` is the parsed route path (`LivequeryRequestParser.parse(...).schema`), so the document-id segment is already stripped and each `:param` names the document field holding the parent value.
- `collection` must be a static string. Dynamic collection, database, or connection resolver functions are skipped because database watchers must be known up front.
- When watching a `MongoClient`, `db` or `config.databases` decides which database names to watch. When watching a `Db`, that database is used directly.

By default, `MongodbRealtime` enables MongoDB pre/post images with `collMod` and watches with `fullDocument: 'updateLookup'` and `fullDocumentBeforeChange: 'whenAvailable'`.

Disable the `collMod` call when your deployment manages pre/post images separately:

```ts
new MongodbRealtime({ enablePreAndPostImages: false })
```

For nested collection refs, name the route param after the document field that holds the parent value:

```ts
{
  schema: 'users/:userId/posts',
  options: { collection: 'posts', realtime: true },
}
```

If the document field is an array (one document belongs to many parents), the change is fanned out to one ref per array element, and array membership changes emit `added`/`removed` per ref.

An inserted `{ _id: 'post1', userId: 'user1', title: 'Hello' }` emits:

```ts
{
  ref: 'users/user1/posts',
  type: 'added',
  data: { id: 'post1', userId: 'user1', title: 'Hello' },
}
```

### `DataChangePayload<T>`

Type-only realtime/change payload contract.

```ts
type DataChangePayload<T = any> = {
  id: string
  type: 'added' | 'modified' | 'removed'
  data: T
  refs: Array<{ ref: string, old_ref: string }>
  new_doc: T
}
```

## Configuration Types

### `MongoDatasourceConfig`

```ts
import type { Db, MongoClient } from 'mongodb'

type MongoConnection = MongoClient | Db

type MongoDatasourceConfig = {
  connections: { [key: string]: MongoConnection }
  databases?: string[]
}
```

Fields:

- `connections`: map of connection names to either `MongoClient` or `Db`.
- `databases`: optional list of database names. This is metadata for consumers; collection resolution uses route `db`, `process.env.DB_NAME`, or `"main"`.

Default resolution:

- Connection defaults to the first configured connection name, then `"default"`.
- Database defaults to route `db`, then `process.env.DB_NAME`, then `"main"`.
- If the connection is a `MongoClient`, the datasource calls `client.db(dbName)`.
- If the connection is already a `Db`, that `Db` is used directly.

### `RouteOptions`

```ts
type RouteOptions = {
  realtime?: boolean
  collection: string | ((req: LivequeryRequest) => Promise<string> | string)
  db?: string | ((req: LivequeryRequest) => Promise<string> | string)
  connection?: string | ((req: LivequeryRequest) => Promise<string> | string)
  objectIdFields?: string[]
}
```

Fields:

- `realtime`: marks a static collection route for `MongodbRealtime.watch()`. Query execution itself is unchanged.
- `collection`: required collection name or resolver function.
- `db`: optional database name or resolver function.
- `connection`: optional connection name or resolver function.
- `objectIdFields`: top-level request fields that should be converted from valid string ids to `ObjectId`.

Use function values when tenant, database, or collection depends on request keys.

## Core Usage Example

```ts
import { MongoClient } from 'mongodb'
import { LivequeryRequestParser, type LivequeryContext } from '@livequery/core'
import { MongoDatasource } from '@livequery/mongodb'

const client = new MongoClient(process.env.MONGO_URL!)
await client.connect()

const datasource = new MongoDatasource({
  connections: { default: client },
  databases: ['main'],
})

await datasource.init([
  {
    method: 'GET',
    path: '/products',
    collection: 'products',
  },
  {
    method: 'GET',
    path: '/products/:id',
    collection: 'products',
  },
])

const ctx: LivequeryContext = {
  request: {
    method: 'GET',
    path: '/products',
    ref: '/products',
    params: {},
    query: { ':limit': 20, 'price:sort': 'desc' },
    headers: new Map(),
  },
}

new LivequeryRequestParser().handle(ctx)
await datasource.handle(ctx)

console.log(ctx.response)
```

## Core Document Route Example

```ts
const ctx: LivequeryContext = {
  request: {
    method: 'GET',
    path: '/products/507f1f77bcf86cd799439011',
    ref: '/products/:id',
    params: { id: '507f1f77bcf86cd799439011' },
    query: {},
    headers: new Map(),
  },
}

new LivequeryRequestParser().handle(ctx)
await datasource.handle(ctx)
```

`LivequeryRequestParser` will set `ctx.livequery.document_id` and `ctx.livequery.keys.id`. The datasource converts `id` to Mongo `_id` for document reads and writes.

## Legacy Usage Example

```ts
import { MongoClient } from 'mongodb'
import { MongoDatasource } from '@livequery/mongodb'

const client = new MongoClient(process.env.MONGO_URL!)
await client.connect()

const datasource = new MongoDatasource()

await datasource.init(
  {
    connections: { default: client },
    databases: ['main'],
  },
  [
    {
      method: 'GET',
      path: '/products',
      options: {
        collection: 'products',
      },
    },
  ]
)

const response = await datasource.query(
  {
    method: 'get',
    ref: 'products',
    is_collection: true,
    collection_ref: 'products',
    schema_collection_ref: 'products',
    keys: {},
    options: { ':limit': 10 },
  },
  {
    collection: 'products',
  }
)

console.log(response.items)
```

## Dynamic Tenant Example

```ts
await datasource.init([
  {
    method: 'GET',
    path: '/tenant/:tenantId/products',
    connection: req => req.keys.tenantId,
    db: req => `tenant_${req.keys.tenantId}`,
    collection: req => `products_${req.keys.tenantId}`,
    objectIdFields: ['ownerId', 'categoryId'],
  },
])
```

This lets one datasource choose connection, database, and collection per request.

## ObjectId Handling

This package does not use Mongoose schema introspection. Configure ObjectId conversion explicitly.

Use `objectIdFields` for top-level keys and write bodies:

```ts
await datasource.init([
  {
    method: 'PATCH',
    path: '/products/:id',
    collection: 'products',
    objectIdFields: ['ownerId', 'categoryId'],
  },
])
```

Use query suffixes for filter values:

```ts
{
  'ownerId:eq-oid': '507f1f77bcf86cd799439011',
}
```

## Build And Verification

```sh
npm run build
npm test
```

`npm test` runs the Bun test suite. The tests use mocked MongoDB collections, so they do not require a real MongoDB server.

## Notes

- This package is ESM and uses TypeScript `NodeNext`.
- Local imports in source files should include `.js` extensions.
- Do not add Mongoose dependencies here. Mongoose-specific behavior belongs in `@livequery/mongoose`.
- `@livequery/core` is used for types and core handler integration.
