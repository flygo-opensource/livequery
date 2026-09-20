# @livequery/mongodb

Native MongoDB datasource adapter for the `@livequery` ecosystem.

This package translates Livequery request shapes into MongoDB native driver operations. It is intended for projects that want to use `@livequery/core` with plain `mongodb` collections, without Mongoose models or schema introspection.

Integration with `@livequery/core`: `new MongoDatasource(config)`, `init(routes)`, then `handle(ctx)`. For imperative use you can also call `query(req, options)` directly.

Reads are executed with MongoDB aggregation pipelines through `Collection.aggregate(...).toArray()`. Writes use native collection methods such as `insertOne`, `updateOne`, and `deleteOne`.

## Installation

```sh
bun add @livequery/mongodb mongodb rxjs
```

For local development in this workspace, `@livequery/core` is installed as a dev dependency from `file:../core`. Runtime JavaScript does not import `@livequery/core`; the generated declaration files use core types.

## Exports

```ts
export * from './MongoDatasource.js'
export * from './DataChangePayload.js'
export * from './MongodbRealtime.js'
export * from './mongodb.js'
export * from './MongodbCollection.js'
```

## Project Meaning

`@livequery/mongodb` is the MongoDB datasource layer for Livequery.

Its job is not to parse HTTP requests. That belongs to `@livequery/core`, usually through `LivequeryRequestParser`. Its job is also not to provide Mongoose-style schemas, validation, hooks, virtuals, or `populate()`. This package receives a parsed Livequery request, resolves which MongoDB collection should handle it, and runs the corresponding native MongoDB operation.

Typical request flow with `@livequery/core`:

1. A framework adapter creates a `LivequeryContext`.
2. `LivequeryRequestParser` reads `ctx.request` and writes `ctx.livequery`.
3. `MongoDatasource.handle(ctx)` resolves route options from `ctx.request.method` and `ctx.request.ref`.
4. `MongoDatasource` reads `ctx.livequery` (keys, query, body, method) as the adapter request.
5. Reads are delegated to `MongoQuery`; writes go directly to the native collection.
6. The result is assigned to `ctx.response`.

## Main Classes And Types

### `MongoDatasource`

Main adapter class.

```ts
class MongoDatasource extends Subject<UpdatedData<LivequeryBaseEntity>>
```

Responsibilities:

- Store datasource config and route options.
- Initialize from a list of routes.
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

`config` is required before any request runs. Omit it here only if you assign `datasource.config` before the first `handle` / `query` call.

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

- `req: LivequeryRequest`: parsed Livequery request. Reads `req.keys`, `req.query`, `req.method`, and `req.body`.
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
    query: { ':limit': 10 },
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

- `req: LivequeryRequest`: parsed adapter request. Reads `req.keys`, `req.query`, and `req.is_collection` (`req.query` is normalized to `{}` when absent).
- `collection: Collection<T>`: native MongoDB collection.

Behavior:

- For document reads, matches by `req.keys`, converts `req.keys.id` to `_id`, renames `_id` to `id`, and returns a one-item result shape.
- For collection reads, builds an aggregation pipeline with sort, filter, search, id rename, cursor paging, and summary facets.

Known behavior:

- `:limit` defaults to `10`.
- Minimum `:limit` is `1`.
- Maximum `:limit` is `100`.
- Cursor paging (`:after` / `:before` / `:around`) is the default.
- Offset paging is used when `:page` is provided.

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
- `options: Record<string, any>`: the request query (`req.query`). Sort options ending with `:sort` are included in the cursor.

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

### `mongodb()`

A datasource middleware for a Hono-shaped chain — the MongoDB twin of `d1()` in `@livequery/d1`.
Use it when the service is written as middlewares instead of a `LivequeryContext` pipeline:

```ts
import { livequery, realtime, validator } from '@livequery/honojs'
import { mongodb } from '@livequery/mongodb'

const source = mongodb({ connection: db })       // a Db, or a MongoClient plus { db: 'name' }

app.get('/livequery/todos', validator(Todo), livequery(), source, realtime(gateway))
app.post('/livequery/todos', validator(Todo), livequery(), source)
```

| Option | Default | Meaning |
| --- | --- | --- |
| `connection` | — | `Db`, or `MongoClient` together with `db` |
| `collection` | last segment of the request's collection ref | Collection name, or a resolver `(req) => string` |
| `db` | `DB_NAME` env, else `main` | Database name when `connection` is a client |
| `objectIdFields` | `[]` | Fields stored as ObjectId, converted before the query runs |
| `fields` | fields of the route's `validator()` schema | Fields a client may filter, sort or search on |

A query naming a field outside the allowlist is rejected with 400 `FIELD_NOT_ALLOWED`; keys
starting with `:` (`:limit`, `:after`, `:search`, `::summary`) are the protocol's own and always
pass. Without `fields` and without a `validator()` schema the middleware warns once and lets any
field through.

The middleware runs the operation, publishes `livequery_result` and builds the response *before*
calling `next()`, so a `realtime()` after it can still add headers. It does not publish changes:
a service that also runs `MongodbRealtime.watch()` gets those from the change stream, which also
covers writes that never went through the API. See
[`examples/todo-mongodb`](../examples/todo-mongodb/README.md) for the whole app.

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

If the document field is an array (one document belongs to many parents), the change is fanned out to one ref per array element. MongoDB `update`/`replace` events emit `modified` for every affected old and new ref, so realtime event types stay aligned with the database operation type. Insert and delete events still emit `added` and `removed`.

An inserted `{ _id: 'post1', userId: 'user1', title: 'Hello' }` emits:

```ts
{
  ref: 'users/user1/posts',
  type: 'added',
  data: { id: 'post1', userId: 'user1', title: 'Hello' },
}
```

### `MongodbCollection`

Lightweight imperative CRUD wrapper over a native MongoDB collection, with a Mongoose-`Model`-like surface. It is independent of the Livequery request flow and `LivequeryContext`: reach for it when application or service code needs to read and write documents directly, rather than through `MongoDatasource.handle(ctx)`.

It is intentionally not an ODM. There are no schemas, validation, hooks, virtuals, or `populate()`. It only layers a few conveniences over the native driver: `id` / `_id` normalization, a collection-level defaults resolver, automatic timestamps, and flexible single-document filters.

```ts
class MongodbCollection<T = any>
```

Responsibilities:

- Wrap one collection, resolved lazily from a provided `Db`.
- Return documents with an enumerable `id: string` and a hidden `_id`.
- Apply a defaults resolver plus `created_at` / `updated_at` on insert.
- Bump `updated_at` on every update.
- Accept a `string` id, an `ObjectId`, or a filter object for single-document operations.

#### `defineCollection<T>(config)` and `constructor(db, config)`

A collection is described once with `defineCollection`, then bound to a `Db` instance.

`defineCollection<T>({ collection, defaults? })` returns a typed `CollectionDef<T>`:

- `collection: string`: collection name. The handle is resolved lazily via `db.collection(name)`.
- `defaults?: (input: Partial<T>) => Partial<T>`: optional default-field resolver, a replacement for Mongoose `@Prop({ default })`. It runs on every `create` / `insertMany` with the input document; the input always overrides the returned defaults.

`new MongodbCollection<T>(db, config)`:

- `db: Db`: a connected `mongodb` `Db`. It is passed in explicitly (no hidden module singleton), so one class works across databases and connections.
- `config: CollectionDef<T>`: the definition returned by `defineCollection`. The generic `T` is inferred from it, so the instance is fully typed.

Example:

```ts
import { MongoClient } from 'mongodb'
import { MongodbCollection, defineCollection } from '@livequery/mongodb'

const client = new MongoClient(process.env.MONGO_URL!)
await client.connect()
const db = client.db('main')

type Order = { video_id: string; amount: number; started: boolean; running: boolean }
type Video = { title: string }

// With a defaults resolver (replaces Mongoose @Prop({ default })):
const Orders = new MongodbCollection(db, defineCollection<Order>({
  collection: 'orders',
  defaults: () => ({ started: false, running: true }),
}))

// Without defaults:
const Videos = new MongodbCollection(db, defineCollection<Video>({ collection: 'videos' }))
```

Define each collection once at composition time and reuse the instance across the app.

#### Document shape: `MongoDoc<T>`

```ts
type MongoDoc<T> = T & { id: string; toJSON(): any }
```

Returned documents are hydrated:

- `id` is an enumerable string (`_id.toString()`), so it appears in `JSON.stringify`, JSON responses, and `{ ...doc }`.
- `_id` is non-enumerable, so it never leaks into output, yet `doc._id` is still readable as an `ObjectId` internally.
- `toJSON()` returns the document without `_id` and `__v`.

#### Methods

| Method | Description |
| --- | --- |
| `find(filter?)` | Returns hydrated documents. |
| `findOne(filter?)` | `filter` may be a `string` id, an `ObjectId`, or a filter object. |
| `findById(id)` | Shorthand for `findOne` with a `string` id or `ObjectId`. |
| `create(doc)` | Inserts one document; applies defaults + timestamps; strips any incoming `id` / `_id`. |
| `insertMany(docs)` | Inserts many documents with the same preparation as `create`. |
| `updateOne(filter, update, opts?)` | Wraps plain updates in `$set` and bumps `updated_at`; `filter` accepts string id / ObjectId / object. |
| `updateMany(filter, update, opts?)` | Same update handling for many documents. |
| `deleteOne(filter)` | Deletes one; `filter` accepts string id / ObjectId / object. |
| `deleteMany(filter?)` | Deletes many documents. |
| `countDocuments(filter?)` | Counts matching documents. |
| `exists(filter?)` | `true` when at least one document matches. |
| `aggregate(pipeline)` | Runs an aggregation pipeline and returns the array. |
| `collection` | Getter for the raw native `Collection` (escape hatch). |

Behavior:

- Filter normalization: a 24-hex `string` becomes `{ _id: ObjectId }`; an `ObjectId` becomes `{ _id }`; any other string or object is used unchanged.
- Update normalization: an update that already contains a `$`-operator (such as `$inc` or `$push`) is passed through; otherwise it is wrapped in `$set`. `updated_at` is always merged into the `$set` branch.
- Inserts never persist an incoming `id` or `_id`.

Example:

```ts
// create — applies defaults (started/running) + created_at/updated_at; strips any client id/_id
const order = await Orders.create({ video_id: 'v1', amount: 50 })
order.id              // '507f1f77bcf86cd799439011'
order.started         // false — from the defaults resolver
order._id             // ObjectId — still readable internally
JSON.stringify(order) // contains "id", not "_id"

// insertMany — same preparation as create, returns hydrated docs
const [a, b] = await Orders.insertMany([{ video_id: 'v2', amount: 10 }, { video_id: 'v3', amount: 20 }])

// reads — single-doc helpers accept a string id, an ObjectId, or a filter object
await Orders.findOne('507f1f77bcf86cd799439011') // by string id (24-hex → _id)
await Orders.findById(order._id)                 // by ObjectId
await Orders.findOne({ video_id: 'v1' })         // by filter
await Orders.find({ started: false })            // many

// updates — plain bodies are wrapped in $set; operator bodies pass through; updated_at always bumped
await Orders.updateOne(order.id, { amount: 80 })            // → { $set: { amount: 80, updated_at } }
await Orders.updateOne(order.id, { $inc: { amount: 5 } })   // → { $inc, $set: { updated_at } }
await Orders.updateMany({ started: false }, { running: true })

// existence / counting
await Orders.exists(order.id)                    // boolean
await Orders.countDocuments({ video_id: 'v1' })  // number

// delete
await Orders.deleteOne(order.id)
await Orders.deleteMany({ video_id: 'v3' })

// escape hatches
await Orders.aggregate([{ $group: { _id: '$video_id', total: { $sum: '$amount' } } }])
Orders.collection                                // raw native Collection
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

## Direct Query Example

For imperative use, call `query(req, options)` directly without going through `handle(ctx)`. Pass the config to the constructor; `init(routes)` is not required for this path since the collection is given in `options`.

```ts
import { MongoClient } from 'mongodb'
import { MongoDatasource } from '@livequery/mongodb'

const client = new MongoClient(process.env.MONGO_URL!)
await client.connect()

const datasource = new MongoDatasource({
  connections: { default: client },
  databases: ['main'],
})

const response = await datasource.query(
  {
    method: 'get',
    ref: 'products',
    is_collection: true,
    keys: {},
    query: { ':limit': 10 },
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
