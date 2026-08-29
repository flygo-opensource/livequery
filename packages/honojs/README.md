# @livequery/honojs

Hono framework adapter for the `@livequery` ecosystem. Provides request parsing middleware, route registration helpers, response utilities, an API gateway, and a service linker for building livequery-compatible REST APIs with [Hono](https://hono.dev).

---

## Installation

```bash
npm install @livequery/honojs @livequery/core hono
```

Peer dependency: `hono >= 4.12`. Bun-specific discovery, gateway, and realtime
transport are provided transitively by `@livequery/bunjs`.

---

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
} from '@livequery/honojs'

const app = new Hono()
const websocketGateway = new WebsocketGateway()
const livequery = createLivequery(app, { websocketGateway })

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
} from '@livequery/honojs'

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

An API gateway auto-discovers upstream services over UDP and proxies HTTP requests. Client id headers (`x-lcid`, `x-lgid`) are forwarded so upstream services can register realtime subscriptions.

```ts
import { Hono } from 'hono'
import { HonoApiGatewayLinker, WebsocketGateway } from '@livequery/honojs'

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
import { HonoApiGateway } from '@livequery/honojs'

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

The middleware calls `websocketGateway.listen(...)` with the resource `ref` and client/gateway ids. No subscription is registered when cursor params (`:after`, `:before`, `:around`) are present — pagination requests are one-off fetches.

```ts
// Just pass websocketGateway when creating the router — no extra code needed.
const livequery = createLivequery(app, { websocketGateway })
```

The `x-lgid` header can specify a gateway id when routing through multiple gateways. If absent, `websocketGateway.id` is used.

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
import { Subject } from 'rxjs'
import { createDatasourceMapper, createLivequery, livequeryJson } from '@livequery/honojs'
import type { LivequeryDatasource } from '@livequery/honojs'
import type { LivequeryBaseEntity, LivequeryRequest, WebsocketSyncPayload } from '@livequery/types'

type Product   = LivequeryBaseEntity & { name: string }
type Config    = { db: Product[] }
type RouteOpts = { collection: 'products' }

class ProductDatasource
    extends Subject<WebsocketSyncPayload<LivequeryBaseEntity>>
    implements LivequeryDatasource<Config, RouteOpts>
{
    #config!: Config

    async init(config: Config): Promise<void> { this.#config = config }

    async query(req: LivequeryRequest, opts: RouteOpts) {
        const items = this.#config[opts.collection]
        if (req.is_collection) return { items }
        return { item: items.find(p => p.id === req.doc_id) }
    }
}

const app = new Hono()
const livequery = createLivequery(app)

// Placeholder handlers — replaced after async init
let listHandler = (c: any) => livequeryJson(c, { items: [] })
let itemHandler = (c: any) => livequeryJson(c, { item: {} })

livequery.get('/livequery/products',     c => listHandler(c))
livequery.get('/livequery/products/:id', c => itemHandler(c))

const useDatasource = await createDatasourceMapper({
    datasource: new ProductDatasource(),
    routes: livequery.registry,
    config: { db: [{ id: 'p-1', name: 'Keyboard' }] },
})

listHandler = useDatasource({ collection: 'products' })
itemHandler = useDatasource({ collection: 'products' })
```

Note: the `LivequeryRequest` received in `datasource.query()` is from `@livequery/types`
and has `doc_id`, `is_collection`, and `options` — distinct from the `@livequery/core`
type returned by `getLivequeryRequest(c)`.

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

    // Bun runtime contracts re-exported from @livequery/bunjs
    RealtimeSubscription,
    UdpDiscoveryNode,
    UdpDiscoveryOptions,
    UdpDiscoveryPacket,
    UdpDiscoveryStatus,
} from '@livequery/honojs'
```
