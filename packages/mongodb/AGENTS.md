# Agent Notes For @livequery/mongodb

This package is a TypeScript ESM datasource adapter between `@livequery/core` request shapes and native MongoDB driver collections.

Use this document when an agent needs to inspect, edit, or extend the package.

## Project Meaning

`@livequery/mongodb` is the MongoDB datasource implementation for Livequery.

It receives parsed Livequery requests, decides which MongoDB collection should handle them, and executes native MongoDB operations. It deliberately does not use Mongoose. Any behavior that depends on Mongoose schemas, validation, hooks, virtuals, or `populate()` belongs in a different package, such as `@livequery/mongoose`.

The package supports both:

- `@livequery/core` handler integration with `init(routes)` and `handle(ctx)`.
- Legacy direct datasource integration with `init(config, routes)` and `query(req, options)`.

Keep both APIs working unless the user explicitly asks for a breaking change.

## Architecture

- `src/index.ts`: public exports.
- `src/types.ts`: adapter-local types. `LivequeryRequest` is based on the core request type but adds legacy fields such as `options` and `is_collection`.
- `src/MongoDatasource.ts`: main datasource adapter.
- `src/MongoQuery.ts`: static read query builder that creates MongoDB aggregation pipelines.
- `src/Cursor.ts`: cursor encode/decode helper.
- `src/SmartCache.ts`: promise cache for native collection handles.
- `src/DataChangePayload.ts`: type-only realtime/change payload contract.
- `src/MongodbRealtime.ts`: MongoDB change stream watcher that formats Livequery websocket sync payloads.
- `src/MongodbCollection.ts`: imperative CRUD wrapper (Mongoose `Model`-like) over a native collection; independent of the request flow.

## Core Type Integration

`MongoDatasource` imports these types from `@livequery/core`:

```ts
import type {
  LivequeryContext,
  LivequeryDatasource as CoreLivequeryDatasource,
  LivequeryDatasourceInitConfig
} from '@livequery/core'
```

`src/types.ts` imports the core request type:

```ts
import type { LivequeryRequest as CoreLivequeryRequest } from '@livequery/core'
```

Do not reintroduce `@livequery/types`. This package should use `@livequery/core` for core-facing types and local adapter types for behavior that core does not define.

Runtime JavaScript should not import `@livequery/core`; type-only imports are expected in declaration files.

## Main Classes And Methods

### `MongoDatasource`

Primary adapter.

Responsibilities:

- Store `MongoDatasourceConfig`.
- Store route options in a map.
- Resolve MongoDB connection, database, and collection per request.
- Convert core `ctx.livequery.query` to adapter `req.options`.
- Normalize configured ObjectId fields.
- Delegate reads to `MongoQuery`.
- Execute writes through native MongoDB collection methods.
- Implement `handle(ctx)` for `@livequery/core`.

#### `constructor(config?)`

Parameters:

- `config?: MongoDatasourceConfig`: optional config with MongoDB connections.

Use it for core-style setup:

```ts
const datasource = new MongoDatasource({
  connections: { default: client },
  databases: ['main'],
})
```

#### `init(routes)`

Core-style route registration.

Parameters:

- `routes`: array of `RouteOptions & { method: string; path: string }`.

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

The datasource stores both `METHOD path` and path-only keys. Keep the `METHOD path` lookup and the path-only fallback.

#### `init(config, routes)`

Legacy route registration.

Parameters:

- `config: MongoDatasourceConfig`: connection config.
- `routes`: array of legacy route entries where route options are nested under `options`.

Example:

```ts
await datasource.init(config, [
  {
    method: 'GET',
    path: '/products',
    options: {
      collection: 'products',
    },
  },
])
```

Legacy entries may also use `config` instead of `options`; preserve that compatibility.

#### `handle(ctx)`

Core handler method.

Parameters:

- `ctx: LivequeryContext`: must contain `ctx.request`; must have `ctx.livequery` populated before this method runs.

Behavior:

- Throws `INVALID_LIVEQUERY_REQUEST` when `ctx.livequery` is absent.
- Converts core `ctx.livequery` into the adapter request shape.
- Resolves route options from `ctx.request.method` and `ctx.request.ref || ctx.request.path`.
- Calls `query(req, options)`.
- Writes the result to `ctx.response`.

Expected core pipeline:

```ts
new LivequeryRequestParser().handle(ctx)
await datasource.handle(ctx)
```

For dynamic routes, `ctx.request.ref` should be the route pattern:

```ts
{
  path: '/products/507f1f77bcf86cd799439011',
  ref: '/products/:id',
  params: { id: '507f1f77bcf86cd799439011' },
}
```

#### `query(req, options)`

Direct execution method for legacy callers and internal core handling.

Parameters:

- `req: LivequeryRequest`: parsed request. It may contain core `query` or legacy `options`; `MongoDatasource` normalizes both to `req.options`.
- `options: RouteOptions`: collection/database/connection configuration.

Supported methods:

- `get`: read collection or document.
- `post`: insert one document.
- `put`: update one document.
- `patch`: update one document.
- `delete`: delete one document.

Write details:

- `post` merges `req.keys` and `req.body`, then calls `insertOne`.
- `put` and `patch` call `updateOne(this.#keys(req), this.#update(req.body))`.
- Plain update bodies become `{ $set: body }`.
- Operator update bodies are passed through unchanged.
- `delete` calls `deleteOne(this.#keys(req))`.

Do not remove `query(req, options)`.

### `MongoQuery`

Static query builder for reads.

Responsibilities:

- Parse filters from `req.options`.
- Merge `req.keys` into read filters.
- Parse summary options that start with `::`.
- Build cursor pagination facets.
- Convert `_id` to `id` for responses.
- Execute `collection.aggregate(...).toArray()`.

Main method:

```ts
MongoQuery.query(req, collection)
```

Parameters:

- `req: LivequeryRequest`: normalized request with `keys`, `options`, and `is_collection`.
- `collection: Collection<T>`: native MongoDB collection.

Known behavior:

- `:limit` defaults to `10`.
- Minimum `:limit` is `1`.
- Maximum `:limit` is `100`.
- Cursor values are hex-encoded JSON from `Cursor`.
- Offset paging is currently not implemented; cursor paging is the active path.

Supported filter suffixes include:

- `field:eq`
- `field:ne`
- `field:lt`
- `field:lte`
- `field:gt`
- `field:gte`
- `field:in`
- `field:nin`
- `field:like`
- `field:eq-number`
- `field:neq-number`
- `field:eq-boolean`
- `field:neq-boolean`
- `field:eq-null`
- `field:neq-null`
- `field:eq-oid`
- `field:neq-oid`

Supported read options include:

- `:limit`
- `:after`
- `:before`
- `:around`
- `:search`
- `field:sort`
- `::summaryName`

### `Cursor`

Cursor helper.

Methods:

- `Cursor.caculate(item, options)`: builds a hex cursor from `item.id` and active `field:sort` values.
- `Cursor.parse(cursor)`: decodes a hex cursor into an object.

Keep the method name `caculate` for compatibility unless doing a breaking cleanup.

### `SmartCache`

Async cache for collection handles.

Method:

- `get(key, resolver)`: returns the cached promise result for `key`, or stores and returns `resolver()`.

The collection cache key must include connection, database, and collection:

```ts
`${connectionName}|${dbName}|${collectionName}`
```

Do not reduce this key, or handles may be reused across tenants/connections.

### `DataChangePayload`

Type-only realtime/change payload contract.

Fields:

- `id`: changed document id.
- `type`: `added`, `modified`, or `removed`.
- `data`: payload data.
- `refs`: affected refs.
- `new_doc`: new document state.

### `mongodb()`

Datasource middleware for a Hono-shaped chain, the MongoDB twin of `d1()` from `@livequery/d1`:

```ts
app.get('/livequery/todos', validator(Todo), livequery(), mongodb({ connection: db }), realtime(gateway))
```

Options: `connection` (a `Db`, or a `MongoClient` plus `db`), `collection` (default: the last
segment of the request's collection ref), `db`, `objectIdFields`, `fields`.

Behavior:

- Reads `livequery_request` from the context and calls `MongoDatasource.query(req, options)`; it
  never touches `init()`/`handle()`, so one middleware instance serves any route it is put on.
- Rejects a query naming a field outside the allowlist with 400 `FIELD_NOT_ALLOWED`. The
  allowlist is `fields`, or the shape of the route's `validator()` schema; keys starting with `:`
  are the protocol's own and always pass.
- Publishes `livequery_result`, builds the response (201 for POST, 200 otherwise) **before**
  calling `next()`, so `realtime()` after it can still add headers, and throws
  `toLivequeryError(e)` on failure so a framework error handler sees a real `Error`.
- Does not publish changes. A service that also runs `MongodbRealtime.watch()` gets them from the
  change stream, which covers writes that never went through this middleware.

### `MongodbRealtime`

MongoDB change stream watcher for static realtime routes.

`watch(config, routes)` takes `MongoRealtimeRoute` entries:

```ts
type MongoRealtimeRoute = {
  schema: string        // LivequeryRequestParser.parse(...).schema, e.g. 'users/:userId/posts'
  options: RouteOptions
}
```

Responsibilities:

- Watch routes with `realtime: true` and a static string `collection`.
- Skip routes with dynamic collection, database, or connection resolver functions.
- Enable MongoDB pre/post images by default before opening a change stream.
- Convert MongoDB change stream events to Livequery websocket sync payloads.
- Format nested refs from `schema` params: each `:param` reads the document field of the same name (`id` maps to `_id`). The schema comes pre-parsed from `@livequery/core`, so the document-id segment is already stripped.
- Support array membership refs automatically when the document field is an array.

### `MongodbCollection`

Imperative CRUD wrapper over one native collection, with a Mongoose `Model`-like surface. Independent of the request flow (`LivequeryContext` / `handle`); for direct application/service reads and writes. Not an ODM: no schemas, validation, hooks, virtuals, or `populate()`.

`constructor(db, collectionName, resolveDefaults?)`:

- `db: Db`: passed in explicitly (no module singleton); the collection handle is resolved lazily via `db.collection(name)`.
- `resolveDefaults?: (input) => Partial<T>`: per-insert default resolver (replaces `@Prop({ default })`); input overrides the returned defaults.

Behavior:

- Hydrate: returned docs expose an enumerable `id: string` and hide `_id` (still readable as `doc._id`); `toJSON()` drops `_id`/`__v`.
- API: `find`, `findOne`, `findById`, `create`, `insertMany`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`, `countDocuments`, `exists`, `aggregate`, plus a `collection` getter.
- `findOne`/`findById`/`updateOne`/`deleteOne` accept a `string` id (24-hex → `{ _id: ObjectId }`), an `ObjectId`, or a filter object.
- Updates wrap plain bodies in `$set` and always merge `updated_at`; bodies that already use a `$`-operator pass through and still bump `updated_at`.
- `create`/`insertMany` add `created_at`/`updated_at`, apply defaults, and never persist an incoming `id`/`_id`.

## Configuration Types

### `MongoDatasourceConfig`

```ts
type MongoDatasourceConfig = {
  connections: { [key: string]: MongoClient | Db }
  databases?: string[]
}
```

Rules:

- `connections` can contain `MongoClient` or `Db`.
- When connection is `MongoClient`, use `client.db(dbName)`.
- When connection is `Db`, use it directly.
- Default connection is the first configured connection name, then `"default"`.
- Default database is route `db`, then `process.env.DB_NAME`, then `"main"`.

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

Rules:

- `collection` is required.
- `collection`, `db`, and `connection` may be strings or resolver functions.
- Resolver functions receive the normalized adapter request.
- Nested route params read the document field of the same name (`id` maps to `_id`); array fields fan out per element.
- `objectIdFields` converts top-level matching fields in `req.keys` and `req.body`.
- Nested ObjectId conversion is not implemented.

## Examples For Agents

### Core Collection Read

```ts
import { MongoClient } from 'mongodb'
import { LivequeryRequestParser } from '@livequery/core'
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
])

const ctx = {
  request: {
    method: 'GET',
    path: '/products',
    ref: '/products',
    params: {},
    query: { ':limit': 10, 'price:sort': 'desc' },
    headers: new Map(),
  },
}

new LivequeryRequestParser().handle(ctx)
await datasource.handle(ctx)
```

### Core Document Read

```ts
await datasource.init([
  {
    method: 'GET',
    path: '/products/:id',
    collection: 'products',
  },
])

const ctx = {
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

### Legacy Direct Query

```ts
const datasource = new MongoDatasource()

await datasource.init(config, [
  {
    method: 'GET',
    path: '/products',
    options: {
      collection: 'products',
    },
  },
])

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

### Dynamic Tenant Routing

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

### ObjectId Filter

```ts
{
  'ownerId:eq-oid': '507f1f77bcf86cd799439011',
}
```

## Important Compatibility Rules

- Do not remove `query(req, options)`.
- Do not remove `init(config, routes)`.
- Do not remove `init(routes)`.
- Do not remove `handle(ctx)`.
- Do not change route lookup without preserving `METHOD path`.
- Keep the path-only route fallback.
- Do not reintroduce `@livequery/types`.
- Do not add Mongoose dependencies.
- Keep local TypeScript imports in NodeNext style with `.js` extensions.
- Keep `tsconfig.json` `"types": ["node"]`; local `@livequery/core` can bring Bun globals into `node_modules`.

## Build And Verification

Run:

```sh
npm run build
npm test
```

`npm test` runs `bun test`. The tests use mocked MongoDB collections, so they do not require a real MongoDB server.

Useful smoke test shape:

```ts
new LivequeryRequestParser().handle(ctx)
await datasource.handle(ctx)
```

Check both:

- Collection route, such as `GET /products`.
- Document route with pattern ref, such as `GET /products/:id`.
