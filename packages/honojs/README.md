# @livequery/honojs

Hono framework adapter for the `@livequery` ecosystem. Provides request parsing middleware, route registration helpers, response utilities, an API gateway, and a service linker for building livequery-compatible REST APIs with [Hono](https://hono.dev).

---

## Installation

```bash
npm install @livequery/honojs @livequery/core hono
```

Peer dependency: `hono >= 4.12`.

| Entry | Runtime | Contents |
| --- | --- | --- |
| `@livequery/honojs` | Any | Middleware, request/response helpers, route registry, datasource mapper, `gateway()`, and a `serve()` built for whichever runtime imports it |
| `@livequery/honojs/bun` | Bun | Root + `HonoApiGateway*`, `HonoApiServiceLinker`, `WebsocketGateway` (`Bun.serve`) |
| `@livequery/honojs/node` | Node.js | Root + the same gateway/linker, `WebsocketGateway` on `ws` (install `ws`) |

### One file, three runtimes

The root entry ships three builds; the runtime picks its own through the `workerd`, `bun` and
`node` export conditions, so nothing in your code has to test for a runtime:

```ts
import { serve } from '@livequery/honojs'

export default serve(app, { port: 8080, realtime: gateway })
```

| | Workers | Bun | Node |
| --- | --- | --- | --- |
| What `serve()` returns | the app (the platform owns the port) | a `Bun.serve` definition: `{ port, fetch, websocket }` | the app, after starting `http.createServer().listen(port)` |
| `realtime` | ignored; sockets live in a Durable Object | `attachBunUpgrade` + websocket handlers | attached to the same HTTP server |
| Node built-ins in the bundle | none (a Workers bundle stays ~70 KB) | — | — |

The root entry loads no Node built-in, `ws` or UDP transport, so it is safe on Cloudflare
Workers. For UDP discovery import `UdpDiscovery` from `@livequery/core/udp`.

---

## Middleware chain

The shortest way to serve a Livequery resource: validate, parse, run the datasource, then
subscribe or publish. Each step is an ordinary Hono middleware, so your own middlewares slot in
anywhere.

```ts
import { Hono } from 'hono'
import { errorHandler, livequery, realtime, validator } from '@livequery/honojs'
import { d1 } from '@livequery/d1'
import { z } from 'zod'

const Task = z.strictObject({
    title: z.string().min(1),
    status: z.enum(['todo', 'done']).default('todo'),
})

const app = new Hono<{ Bindings: Env }>()
app.onError(errorHandler())

app.get('/livequery/tasks', validator(Task), livequery(), d1(), realtime())
app.post('/livequery/tasks', validator(Task), livequery(), d1(), realtime())
app.get('/livequery/tasks/:id', validator(Task), livequery(), d1(), realtime())
app.patch('/livequery/tasks/:id', validator(Task), livequery(), d1(), realtime())
app.delete('/livequery/tasks/:id', livequery(), d1(), realtime())
```

| Middleware | Reads | Writes to the context | Answers? |
| --- | --- | --- | --- |
| `validator(Schema)` | raw body | the schema (the route's column allowlist) and the validated body | only on invalid input (400) |
| `livequery()` | the request and the validated body | `livequery`: ref, keys, document_id, query, body | no |
| `d1()` (from `@livequery/d1`) | `livequery`, the schema, `env` | `livequery_result` | builds the response, then runs the rest of the chain |
| `realtime(target?)` | `livequery`, `livequery_result` | — | no; adds headers or calls the gateway |

Notes on the order:

- `validator` runs **before** `livequery`, which then parses the validated body, so schema
  defaults and transforms survive. `PATCH` validates against `schema.partial()` when the schema
  offers it.
- The schema doubles as the column allowlist: only its fields may be filtered, sorted or written.
  Without a validator, `d1()` warns once per table and falls back to rejecting malformed column
  names only.
- The datasource middleware builds the response **before** calling `next()`, which is why
  `realtime()` sits at the end and can still set headers.
- Your own middlewares are plain Hono: put them between `livequery()` and the datasource to
  shape the request (`c.var.livequery.keys.owner_id = c.var.user.id` becomes a WHERE clause), or
  before `validator` for auth.

### realtime()

| Argument | Where | What it does |
| --- | --- | --- |
| none | a service behind a gateway | Adds `x-livequery-ref` after a read and `x-livequery-change: <type> <ref>` after a write; the gateway registers and publishes |
| a realtime gateway | Node or Bun, sockets in this process | `listen(...)` after a read, `next(change)` after a write |
| `{ register, publish }` | Cloudflare Workers | Hands the work to `CloudflareRealtimePublisher`, whose sockets live in a Durable Object |

Reads only subscribe when the client sent `x-lcid`, and pagination requests (`:after`, `:before`,
`:around`) are skipped: they re-read a ref the client already watches.

## Gateway

`gateway()` proxies to the service that owns a path prefix, and runs realtime on its behalf.

```ts
import { gateway, errorHandler } from '@livequery/honojs'
import routing from './routing.json'

const app = new Hono<AppEnv>()
app.onError(errorHandler())
app.use('/livequery/*', auth())                       // your middleware; sets c.var.principal
app.use('*', gateway({ routing, realtime: shards, principal: c => c.get('principal') }))
```

```json
{
    "services": {
        "tasks":     { "binding": "TASKS_SERVICE", "url": "http://tasks:8081" },
        "incidents": { "binding": "INCIDENTS_SERVICE" }
    },
    "routes": {
        "livequery": {
            "tasks": { "$service": "tasks" },
            "customers": { ":customer_id": { "orders": { "$service": "orders" } } }
        }
    }
}
```

- Keys starting with `$` are metadata; every other key is a path segment, and `:name` matches any
  segment. `$service` and `$auth` are inherited downwards, and the **deepest** `$service` wins.
- Routing is by prefix: a service can add routes under its own prefix without a gateway deploy.
  Only a new service needs one, because it needs a new binding.
- The target carries both `binding` (a Cloudflare Service Binding) and `url`; each runtime uses
  what it has.
- A path no service owns falls through to the next handler.

The gateway learns what realtime to do from two response headers the service sets through
`realtime()`: `x-livequery-ref` after a read and `x-livequery-change: <type> <ref>` after a write.
It acts on them and strips them, so services stay plain REST workers and never bind to the
realtime Durable Object.

## Quick start: simple service

Use `createLivequery` to register routes. It automatically applies the livequery middleware to every route and tracks paths in a registry for service discovery.

```ts
import { Hono } from 'hono'
import {
    createLivequery,
    getLivequeryRequest,
    livequeryJson,
    HonoApiServiceLinker,
    WebsocketGateway,
} from '@livequery/honojs/bun'

const app = new Hono()
const websocketGateway = new WebsocketGateway()
const livequery = createLivequery(app, { realtime: websocketGateway })

// Collection route
livequery.get('/livequery/products', c => {
    return livequeryJson(c, {
        items: [
            { _id: 'p-1', name: 'Keyboard' },
            { _id: 'p-2', name: 'Mouse' },
        ],
    })
})

// Document route
livequery.get('/livequery/products/:id', c => {
    const req = getLivequeryRequest(c)
    return livequeryJson(c, {
        item: { id: req.document_id, name: `Product ${req.document_id}` },
    })
})

// POST / PATCH / DELETE
livequery.post('/livequery/products', c => {
    const req = getLivequeryRequest(c)
    return livequeryJson(c, { item: { id: 'new-id', ...req.body as object } }, 201)
})

// Broadcast this service's routes so a gateway can discover it
const linker = new HonoApiServiceLinker({ routes: livequery.registry, websocketGateway })
const server = Bun.serve({
    port: 3001,
    fetch(request, server) {
        if (websocketGateway.attachBunUpgrade(request, server)) return
        return app.fetch(request)
    },
    websocket: websocketGateway.getBunWebsocketHandlers(),
})
linker.start('products-service', server.port)
```

`_id` is renamed to `id` and other `_`-prefixed fields are stripped automatically by `livequeryJson` (see [Private field stripping](#private-field-stripping)).

---

## Quick start: plain Hono app

If you prefer to register routes directly on a Hono app, use `collectServicePaths` to extract the path list and apply the `livequery()` middleware manually.

```ts
import { Hono } from 'hono'
import {
    livequery,
    collectServicePaths,
    getLivequeryRequest,
    livequeryJson,
    HonoApiServiceLinker,
} from '@livequery/honojs/bun'

const app = new Hono()

app.get('/livequery/products',
    livequery({ routePath: '/livequery/products' }),
    c => livequeryJson(c, { items: [] })
)

app.get('/livequery/products/:id',
    livequery({ routePath: '/livequery/products/:id' }),
    c => {
        const req = getLivequeryRequest(c)
        return livequeryJson(c, { item: { id: req.document_id } })
    }
)

const linker = new HonoApiServiceLinker({ routes: collectServicePaths(app) })
linker.start('products-service', 3001)
```

Passing `routePath` to `livequery()` is required for correct `ref`, `collection_ref`, and `document_id` parsing. When omitted, the actual URL path is used as `ref` and `document_id` is never populated.

---

## API gateway

An API gateway auto-discovers upstream services (HTTP discovery by default, or pass a
`UdpDiscovery` from `@livequery/core/udp`) and proxies HTTP requests. Client id headers (`x-lcid`, `x-lgid`) are forwarded so upstream services can register realtime subscriptions.

```ts
import { Hono } from 'hono'
import { HonoApiGatewayLinker, WebsocketGateway } from '@livequery/honojs/bun'

const app = new Hono()
const websocketGateway = new WebsocketGateway()
const gateway = new HonoApiGatewayLinker({ websocketGateway })

app.all('*', gateway.handler())

Bun.serve({
    port: 3000,
    fetch(request, server) {
        if (websocketGateway.attachBunUpgrade(request, server)) return
        return app.fetch(request)
    },
    websocket: websocketGateway.getBunWebsocketHandlers(),
})
```

Routes with no registered upstream return `404 API_NOT_FOUND`. Unreachable upstreams return `502 SERVICE_API_OFFLINE` and are marked offline; after 30 seconds with no reconnect they are removed automatically.

For manual service registration (e.g. in tests), access the underlying handler:

```ts
gateway.gateway.register({
    node_id: 'svc-1',
    hostname: '127.0.0.1',
    port: 3001,
    paths: [{ method: 'GET', path: 'livequery/products/:id' }],
})
```

If you need to subclass `ApiGatewayHandler` directly, use `HonoApiGateway`:

```ts
import { HonoApiGateway } from '@livequery/honojs/bun'

class CustomGateway extends HonoApiGateway {}

const gateway = new CustomGateway({ websocketGateway })
const res = await gateway.fetch(new Request('http://gateway/livequery/products'))
```

---

## Realtime subscriptions

When a client sends a `GET` request with the `x-lcid` header, the middleware registers a realtime subscription so the client receives push updates when data changes.

```
GET /livequery/products
x-lcid: client-abc123
```

The subscription is registered **after** the handler, and only when the response is 2xx, so
a read that failed (403, 404, validation) never subscribes the caller. No subscription is
registered when cursor params (`:after`, `:before`, `:around`) are present — pagination requests
are one-off fetches.

`realtime` takes one of two forms:

```ts
// Bun / Node: an in-process realtime gateway (any WebsocketGatewayBase)
const livequery = createLivequery(app, { realtime: websocketGateway })

// Cloudflare Workers: sockets live in a Durable Object, so register through the publisher.
// Awaited before the response is sent. Requires x-lgid (the gid from the client's hello).
import { CloudflareRealtimePublisher } from '@livequery/core/workers'

const app = new Hono<{ Bindings: Env; Variables: { principal: string } }>()
const livequery = createLivequery(app, {
    realtime: (subscription, c) =>
        createPublisher(c.env).register(subscription, c.get('principal')),
})
```

With a gateway object, `x-lgid` names the gateway when routing through several; if absent the
gateway's own `id` is used. `websocketGateway` is still accepted as a deprecated alias of `realtime`.

## Datasources

`createDatasourceMapper` accepts any datasource with `init(routes)` and `query(req, options)`:
`MongoDatasource`, `PostgresDatasource` and `D1Datasource` fit without a cast.

```ts
import { D1Datasource } from '@livequery/d1'
import { env } from 'cloudflare:workers'

const datasource = new D1Datasource({ databases: { default: env.DB } })
const use = await createDatasourceMapper({ datasource, routes })
livequery.get('/livequery/tasks', use({ table: 'tasks', fields: ['title', 'status'] }))
```

Pass `watcher` and `realtime` to forward a change feed (Mongo change streams, Postgres NOTIFY)
into the service's realtime gateway.

---

## Private field stripping

`livequeryJson` strips private fields from `item` and `items` before sending.

Rules applied to each item:
- `_id` is renamed to `id` (only when `id` is not already set).
- Any other key starting with `_` is removed.
- All other keys pass through unchanged.

```ts
livequeryJson(c, {
    item: { _id: 'abc', name: 'Widget', _internalToken: 'xyz', price: 9.99 },
})
// Sends: { "item": { "id": "abc", "name": "Widget", "price": 9.99 } }
```

For array responses:

```ts
livequeryJson(c, {
    items: [
        { _id: 'p-1', name: 'Keyboard', _secret: 'hidden' },
        { _id: 'p-2', name: 'Mouse',    _secret: 'hidden' },
    ],
})
// Sends: { "items": [{ "id": "p-1", "name": "Keyboard" }, { "id": "p-2", "name": "Mouse" }] }
```

Objects that implement `toJSON()` (e.g. Mongoose documents) are serialised via `toJSON()` before field stripping.

To apply the transformation without sending:

```ts
import { mapLivequeryResponse } from '@livequery/honojs'

const mapped = mapLivequeryResponse({ items: [...] })
```

---

## `LivequeryRequest` field reference

`getLivequeryRequest(c)` returns a `LivequeryRequest<unknown>` from `@livequery/core`.

Given route `/livequery/products/:id` and request `GET /livequery/products/p-1?limit=20`:

| Field | Example | Description |
|---|---|---|
| `ref` | `"products/p-1"` | Canonical resource reference (path minus prefix) |
| `collection_ref` | `"products"` | Reference to the parent collection |
| `schema_collection_ref` | `"products"` | Like `collection_ref` but `:param` markers replaced with key names |
| `document_id` | `"p-1"` | Document id; `undefined` for collection routes |
| `keys` | `{ id: "p-1" }` | Hono route params |
| `method` | `"GET"` | HTTP method, always uppercase |
| `body` | `{ name: "..." }` | Parsed JSON body; `undefined` for GET/HEAD |
| `query` | `{ limit: "20" }` | Query string params |
| `path` | `"/livequery/products/p-1"` | Literal URL path |

For collection routes (last route segment is not a `:param`), `document_id` is `undefined` and `ref` equals `collection_ref`.

---

## `createDatasourceMapper`

For services backed by a typed datasource adapter, `createDatasourceMapper` generates Hono handlers without boilerplate.

```ts
import { Hono } from 'hono'
import { createDatasourceMapper, createLivequery, type MappedDatasource } from '@livequery/honojs'

type Product = { id: string; name: string }
type RouteOptions = { collection: 'products' }

const PRODUCTS: Product[] = [{ id: 'p-1', name: 'Keyboard' }]

// Any object with init + query works; real services pass MongoDatasource, PostgresDatasource
// or D1Datasource here.
const datasource: MappedDatasource<RouteOptions> = {
    async init() {},
    async query(req) {
        if (!req.document_id) return { items: PRODUCTS }
        return { item: PRODUCTS.find(p => p.id === req.document_id) }
    },
}

const app = new Hono()
const livequery = createLivequery(app)
const use = await createDatasourceMapper({
    datasource,
    routes: [
        { method: 'GET', path: '/livequery/products', options: { collection: 'products' } },
        { method: 'GET', path: '/livequery/products/:id', options: { collection: 'products' } },
    ],
})

livequery.get('/livequery/products', use({ collection: 'products' }))
livequery.get('/livequery/products/:id', use({ collection: 'products' }))
```

`query` receives the `LivequeryRequest` from `@livequery/core` — the same object
`getLivequeryRequest(c)` returns. Structured errors thrown by the datasource
(`{ status, code, message }`) become the HTTP response.

---

## TypeScript types

```ts
import type {
    // Local types
    LivequeryRoute,          // { method: string; path: string }
    LivequeryResponse,       // { item?: T; items?: T[]; [key: string]: unknown }
    LivequeryVariables,      // { livequery: LivequeryRequest<unknown> }
    LivequeryContext,        // Context<{ Variables: LivequeryVariables }>

    // Protocol contracts re-exported from @livequery/core
    LivequeryRequest,        // parsed request shape (core version)
    LivequeryDatasource,     // datasource contract
    LivequeryDatasourceInitConfig,

    RealtimeSubscription,
    LivequeryRealtimeSubscriber,  // gateway object or (subscription, c) => unknown
    MappedDatasource,             // { init(routes), query(req, options) }
} from '@livequery/honojs'
```
