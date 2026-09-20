# AGENTS.md — @livequery/honojs

Hono framework adapter for the `@livequery` ecosystem. Protocol contracts come
from `@livequery/core`; Bun discovery, gateway, and realtime runtime code comes
from `@livequery/core/bun` via the `/bun` and `/node` entries; the root entry is runtime-neutral. Provides middleware,
route registration helpers, a route registry, response utilities, an API gateway,
and a service linker for building livequery-compatible REST APIs.

---

## File structure

| File | Purpose |
|---|---|
| `src/types.ts` | Shared local types: `LivequeryRoute`, `LivequeryResponse`, `LivequeryVariables`, `LivequeryContext` |
| `src/request.ts` | Builds and parses a `LivequeryRequest` from a Hono `Context`; exposes `createLivequeryRequest` and `getLivequeryRequest` |
| `src/middleware.ts` | Hono middleware (`livequery()`) that runs the parser and optionally registers realtime subscriptions |
| `src/route-registry.ts` | `LivequeryRouter` wrapper, `LivequeryRouteRegistry`, `createLivequery()`, `collectServicePaths()` |
| `src/response.ts` | `livequeryJson()` and `mapLivequeryResponse()` — strip private fields before sending |
| `src/api-gateway.ts` | `HonoApiGateway` (thin subclass) and `HonoApiGatewayLinker` (opaque wrapper with Hono handler) |
| `src/api-service-linker.ts` | `HonoApiServiceLinker` — wraps Bun runtime `ApiServiceLinker`, accepts a registry or plain array |
| `src/datasource.ts` | `createDatasourceMapper()` — initialises a typed datasource and returns a `useDatasource()` handler factory |
| `src/index.ts` | Re-exports all of the above plus protocol symbols from `@livequery/core` and runtime symbols live in `src/bun.ts` / `src/node.ts` (root stays Worker-safe) |

---

## Public API

### `createLivequeryRequest(c, options?)`

```ts
async function createLivequeryRequest(
    c: Context,
    options?: { routePath?: string; body?: unknown }
): Promise<LivequeryRequest<unknown> | undefined>
```

Builds a `RawRequest` from the Hono context and feeds it to a shared
`LivequeryRequestParser` instance. The `routePath` option should be the route
template string (e.g. `/livequery/products/:id`); when omitted, `c.req.path`
is used for both `path` and `ref`, which means `document_id` will never be
populated and `ref` will contain the literal path rather than a canonical ref.

Body is read only for non-GET/HEAD requests with `Content-Type: application/json`.
The raw body is cloned before reading so the original stream remains intact.

Returns `undefined` when the parser cannot produce a result (e.g. empty path).

### `getLivequeryRequest(c)`

```ts
function getLivequeryRequest(c: Context): LivequeryRequest<unknown>
```

Retrieves the already-parsed request stored in Hono context under the `livequery`
variable key. Must be called inside or after the `livequery()` middleware.

### `livequery(options?)`

```ts
function livequery<E extends Env>(options?: {
    realtime?: LivequeryRealtimeSubscriber<E>   // websocketGateway is a deprecated alias
    routePath?: string
}): MiddlewareHandler<E>

type LivequeryRealtimeSubscriber<E> =
    | Pick<WebsocketGatewayBase, 'id' | 'listen'>              // Bun / Node gateway
    | ((subscription: RealtimeSubscription, c: Context<E>) => unknown)  // e.g. Workers publisher.register
```

1. Calls `createLivequeryRequest` with the given `routePath`.
2. Stores the result in context via `c.set('livequery', ...)`.
3. Runs the handler (`await next()`).
4. Only then, if `realtime` is set, the method is `GET`, the response is 2xx and no cursor
   param (`:after`, `:before`, `:around`) is present, registers the subscription:
   - `x-lcid` header (or legacy `socket_id`) must be present (client id).
   - Gateway object: `listen([{ ref, client_id, gateway_id: x-lgid ?? gw.id, listener_node_id: gw.id }])`.
   - Function: requires `x-lgid`; awaited with `{ ref, client_id, gateway_id, listener_node_id }`
     (both ids = `x-lgid`). Errors are logged, never fail the read.

### `createLivequery(app, options?)`

```ts
function createLivequery(app: Hono, options?: LivequeryRouterOptions): LivequeryRouter
```

Returns a `LivequeryRouter` that proxies `.get/.post/.put/.patch/.delete` onto
`app`, prepending `livequery({ ...options, routePath: path })` automatically.
`.use(path, ...handlers)` delegates directly to `app.use()` (no middleware prepended).

### `LivequeryRouter`

```ts
class LivequeryRouter {
    readonly app: Hono
    readonly registry: LivequeryRouteRegistry
    get(path, ...handlers): void
    post(path, ...handlers): void
    put(path, ...handlers): void
    patch(path, ...handlers): void
    delete(path, ...handlers): void
    use(path, ...middlewares): void
}
```

### `LivequeryRouteRegistry`

```ts
class LivequeryRouteRegistry {
    get routes(): LivequeryRoute[]   // returns a copy
    add(method: string, path: string): void
}
```

Routes are `{ method: string; path: string }` where method is uppercased and path
is normalised (leading/trailing slashes stripped, segments joined with `/`).

### `collectServicePaths(app)`

```ts
function collectServicePaths(app: Hono): LivequeryRoute[]
```

Reads `app.routes` directly from a plain Hono app (without `LivequeryRouter`).
Returns the same normalised `{ method, path }` shape. Use when routes are
registered with `app.get()` directly and you still need the path list for a linker.

### `livequeryJson(c, response, status?)`

```ts
function livequeryJson<T extends LivequeryResponse>(
    c: Context,
    response: T,
    status?: number
): Response
```

Applies `mapLivequeryResponse`, then returns `c.json(...)`.

### `mapLivequeryResponse(response)`

Applies `hidePrivateFields` (from `@livequery/core`) to `response.item` or each
element in `response.items`. Items with a `toJSON()` method are serialised first.

`hidePrivateFields` rules:
- `_id` → renamed to `id` (only if `id` is not already set).
- Any other `_`-prefixed key → removed entirely.
- All other keys → preserved.

### `HonoApiGateway`

```ts
class HonoApiGateway extends ApiGatewayHandler {
    constructor(options?: { websocketGateway?: WebsocketGatewayBase; discovery?: Discovery<ServiceApiMetadata>; node_id?: string })
}
```

Thin subclass of Bun runtime `ApiGatewayHandler`. Exposes all runtime methods including
`.register()`, `.deregister()`, `.fetch(request)`, and `.close()`. Use when
you need direct control or subclassing.

Constructor maps `websocketGateway` → core's `ws` option internally.

### `HonoApiGatewayLinker`

```ts
class HonoApiGatewayLinker {
    constructor(options?: { websocketGateway?: WebsocketGatewayBase; discovery?: Discovery<ServiceApiMetadata>; node_id?: string })
    get gateway(): ApiGatewayHandler
    handler(): Handler           // Hono Handler: async c => this.fetch(c)
    fetch(c: Context): Promise<Response>
    close(): void
}
```

Opaque wrapper designed for drop-in use as a Hono catch-all handler. Owns an
`ApiGatewayHandler` internally; exposes it via `.gateway` for introspection.

**`HonoApiGateway` vs `HonoApiGatewayLinker`:**

| | `HonoApiGateway` | `HonoApiGatewayLinker` |
|---|---|---|
| Relationship to Bun runtime | Subclass | Composition |
| Direct runtime API access | Yes | Via `.gateway` |
| Hono handler | Call `.fetch(request)` directly | `.handler()` returns a Hono `Handler` |
| Intended use | Tests, custom setups | `app.all('*', linker.handler())` |

### `HonoApiServiceLinker`

```ts
class HonoApiServiceLinker {
    constructor(options: {
        routes: LivequeryRoute[] | LivequeryRouteRegistry
        websocketGateway?: WebsocketGatewayBase
        discovery?: Discovery<ServiceApiMetadata>   // HttpDiscovery by default, or UdpDiscovery from @livequery/core/udp
        node_id?: string
    })
    start(name: string, port: number): void
    close(): void
}
```

Exported from `/bun` and `/node` only. Wraps core's `ApiServiceLinker`. Accepts a
`LivequeryRouteRegistry` (reads `.routes`) or a plain array. Publishes service metadata through
the given discovery transport so gateways can find it.

### `createDatasourceMapper(options)`

```ts
async function createDatasourceMapper<Config, RouteOptions>(options: {
    datasource: MappedDatasource<RouteOptions>   // { init(routes), query(req, options) }
    watcher?: LivequeryDatasourceWatcher<Config, RouteOptions>
    realtime?: LivequeryRealtimeSink             // { next(update) }; websocketGateway is a deprecated alias
    routes: LivequeryDatasourceRoute<RouteOptions>[] | LivequeryRouteRegistry
    config?: Config | Promise<Config>
}): Promise<(routeOptions: RouteOptions, mapper?: DatasourceMapper) => Handler>
```

Initialises the datasource (`datasource.init(routes)`), optionally pipes the watcher's change
feed into `realtime`, then returns a `useDatasource(routeOptions, mapper?)` factory.

Each handler from `useDatasource`:
1. Reads `LivequeryRequest` from context.
2. Calls `datasource.query(request, routeOptions)`.
3. Applies optional `mapper` or falls back to `hidePrivateFields`.
4. Returns `livequeryJson(c, result)`.

Note: async mapper functions are not supported at runtime.

---

## Key types

```ts
// From src/types.ts
type LivequeryRoute = { method: string; path: string }
type LivequeryResponse<T = unknown> = { item?: T; items?: T[]; [key: string]: unknown }

// From @livequery/core — what getLivequeryRequest() returns
type LivequeryRequest<I> = {
    ref: string                    // e.g. "products/p-1"
    collection_ref: string         // e.g. "products"
    schema_collection_ref: string  // param markers replaced with key names
    document_id?: string           // e.g. "p-1"; undefined for collection routes
    keys: Record<string, any>      // Hono route params, e.g. { id: "p-1" }
    method: string                 // uppercase, e.g. "GET"
    body: I                        // parsed JSON body or undefined
    query: Record<string, any>     // query string params
    path: string                   // literal URL path
}
```

`MappedDatasource.query` receives this same core `LivequeryRequest`.

---

## Invariants and constraints

- `routePath` must be supplied to `createLivequeryRequest` (or the middleware) for
  `document_id`, `ref`, and `collection_ref` to be populated correctly.
  `LivequeryRouter` always passes it automatically.

- Path normalisation: strips leading/trailing slashes, joins segments with `/`.
  Applied in `LivequeryRouter`, `LivequeryRouteRegistry`, and `collectServicePaths`.

- Realtime subscriptions are only registered for `GET` requests. Cursor params
  (`:after`, `:before`, `:around`) in the query string suppress registration.

- `livequeryJson` only strips private fields on `item` and `items`; other top-level
  keys pass through unchanged.

- `HonoApiGatewayLinker.handler()` returns a new closure each call — call once
  and store the result.

- `createDatasourceMapper` must be `await`ed before routes are exercised.

---

## How `LivequeryRequestParser` works

The parser receives two inputs from `RawRequest`:
- `ref`: route template (e.g. `/livequery/products/:id`)
- `path`: actual URL path (e.g. `/livequery/products/p-1`)

Both are stripped of query strings and everything after `~`.

Algorithm:
1. Split `ref` into segments. Find `start`: the index where the *next* segment
   is a param (`:something`) or there is no next segment. This trims the path
   prefix (e.g. `livequery`) down to the canonical resource portion.
2. `document_id` = `paths[refs.length - 1]` **only if** the last `ref` segment
   starts with `:`. Otherwise `undefined` (collection route).
3. `ref` = `paths.slice(start).join('/')`
4. `collection_ref` = path segments up to (but not including) the document segment.
5. `schema_collection_ref` = same as `collection_ref` derived from the template,
   with `:param` markers replaced by their key names (`:id` → `id`).

Example for `/livequery/products/:id` / `/livequery/products/p-1`:
```
refs  = ["livequery", "products", ":id"]
paths = ["livequery", "products", "p-1"]
start = 1   (index where next ref segment starts with ":")
document_id = "p-1"
ref             = "products/p-1"
collection_ref  = "products"
```

---

## Realtime subscription flow

1. Client sends `GET /livequery/products` with `x-lcid: client-abc`.
2. `livequery()` middleware parses the request.
3. No cursor params present → calls:
   ```ts
   ws.listen([{
       ref: "products",
       client_id: "client-abc",
       gateway_id: ws.id,          // or x-lgid header value
       listener_node_id: ws.id,
   }])
   ```
4. Handler executes and returns its HTTP response normally.
5. Future data changes matching `ref` are pushed to the client over WebSocket.
