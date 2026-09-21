# @livequery/core

`@livequery/core` is the framework-agnostic runtime layer for Livequery.

It provides the shared primitives used by HTTP adapters, data-source adapters, API gateway processes, service processes, and realtime synchronization layers. The package does not run database queries by itself and does not require a specific HTTP framework.

The framework-independent Livequery protocol is defined in [`LIVEQUERY_SPEC.md`](./LIVEQUERY_SPEC.md). Read that file for the canonical definitions of refs, collection/document paths, actions, custom actions, response envelopes, response item identity, fake/non-database handlers, and realtime update emission.

## What This Project Does

Livequery treats an HTTP request path as a structured data reference.

Examples:

- `/livequery/posts` points to the `posts` collection.
- `/livequery/posts/p1` points to the `posts/p1` document.
- `/livequery/users/u1/posts` points to the nested `users/u1/posts` collection.
- `/livequery/users/u1/posts/p1` points to the nested `users/u1/posts/p1` document.

This package handles the core infrastructure around that model:

- Parse raw framework requests into normalized `LivequeryRequest` objects.
- Pass request state through a shared `LivequeryContext`.
- Define a handler interface for parser, middleware, datasource, and realtime handlers.
- Discover gateway and service nodes over Ohayo HTTP discovery by default.
- Route HTTP requests through an API gateway to online service nodes.
- Publish service metadata from service nodes.
- Manage realtime WebSocket subscriptions and update forwarding.
- Sanitize response objects by hiding private fields.

## Installation

```sh
bun add @livequery/core
```

For local development in this repository:

```sh
bun install
bun run build
bun test tests/
```

Type-check tests:

```sh
bunx tsc -p tests/tsconfig.json --noEmit
```

## Public Entry Points

The root entry is runtime-neutral: it imports no Node built-ins, no `ws` and no UDP
transport, so it works in Workers, browsers, Bun and Node.

```ts
import { LivequeryRequestParser, WebsocketGatewayBase, hidePrivateFields } from '@livequery/core'
```

Runtime adapters live in their own entries:

```ts
// Node: the realtime gateway on `ws`, plus the http ↔ Fetch helpers
import { WebsocketGateway, nodeRequestToWebRequest, writeWebResponse } from '@livequery/core/node'

// Bun
import { BunWebsocketGateway } from '@livequery/core/bun'

// Cloudflare Workers and Durable Objects
import { HibernatableWebsocketGateway } from '@livequery/core/workers'
```

`ws` is an optional peer dependency, needed only for `WebsocketGateway` from `/node`. The root,
`/bun` and `/workers` entries never load it.

### Migrating from 2.x

3.0 removed the discovery-driven API gateway (`ApiGatewayHandler`, `ApiServiceLinker`,
`HttpDiscovery`, `UdpDiscovery`). A gateway is now a Hono app that routes by path prefix:
`gateway()` from `@livequery/honojs`, fed by a routing file that says which service owns which
prefix. Services no longer announce themselves at runtime; on Cloudflare they are reached through
Service Bindings, and elsewhere through their URL.

Everything else moved rather than changed: import `WebsocketGateway` from `@livequery/core/node`
(it stayed on `ws`) or `@livequery/core/bun`, and the realtime protocol, parser and contracts are
unchanged.

## Cloudflare Workers

`@livequery/core/workers` holds the realtime pieces for Workers and Durable Objects.
A Worker bundle that imports only this entry needs no `nodejs_compat` flag.

| Export | Runs in | Role |
| --- | --- | --- |
| `CloudflareRealtimeRouter` | Worker | Picks the shard for a WebSocket upgrade and attaches the authenticated principal |
| `CloudflareRealtimePublisher` | Worker | Registers a subscription after an authorized read; publishes changes to shards |
| `HibernatableWebsocketGateway` | Durable Object | Holds sockets with the Hibernation API; subscriptions live in storage |
| `EdgeWebsocketGateway` | Durable Object | Legacy `server.accept()` adapter, memory-only state, no hibernation |

```ts
import { DurableObject } from 'cloudflare:workers'
import { HibernatableWebsocketGateway } from '@livequery/core/workers'

export class RealtimeGatewayDO extends DurableObject<Env> {
    readonly #gateway: HibernatableWebsocketGateway

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env)
        this.#gateway = new HibernatableWebsocketGateway(ctx)
    }

    override fetch(request: Request) { return this.#gateway.fetch(request) }
    override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) { this.#gateway.webSocketMessage(ws, message) }
    override webSocketClose(ws: WebSocket) { this.#gateway.webSocketClose(ws) }
    override webSocketError(ws: WebSocket) { this.#gateway.webSocketError(ws) }
    override alarm() { return this.#gateway.alarm() }
}
```

```ts
import { CloudflareRealtimePublisher, CloudflareRealtimeRouter } from '@livequery/core/workers'

const shards = ['shard-0', 'shard-1', 'shard-2', 'shard-3']
const router = new CloudflareRealtimeRouter(env.GATEWAY, {
    shardKey: (_request, principal) => shards[hash(principal) % shards.length],
})
const publisher = new CloudflareRealtimePublisher(env.GATEWAY, { shards: () => shards })

// WebSocket upgrade, after the Worker authenticated the caller:
return router.fetch(request, principal)

// After an authorized GET, before responding:
await publisher.register({ ref, client_id, gateway_id, listener_node_id: gateway_id }, principal)

// After a write:
ctx.waitUntil(publisher.publish({ ref, type: 'added', data: item }))
```

Hibernation: the gateway id is the Durable Object id, so `hello.gid` and `x-lgid`
survive eviction and redeploys. Each socket keeps its `client_id` and principal in
its attachment and each subscription is a `sub:<client_id>:<ref>` storage key; a
woken instance restores both inside `blockConcurrencyWhile`. Client pings are
answered by the runtime (`setWebSocketAutoResponse`) without waking the object. The runtime matches
the frame as an exact string, so `LIVEQUERY_PING_FRAME` and `LIVEQUERY_PONG_FRAME` are protocol
constants: a client sends that literal rather than re-encoding `{ event: 'ping' }`, and every
gateway answers it the same way, on every runtime.

The disconnect grace window is a Durable Object alarm, not a timer: the object can hibernate
while it waits, the window survives eviction, and the same alarm sweeps subscriptions whose
socket never came back. Forward `alarm()` from your Durable Object class.

Trust model:

- Only the Worker reaches the Durable Object; the router forwards WebSocket upgrades
  only, so clients never reach the internal broadcast / subscribe endpoints.
- The router always overwrites `LIVEQUERY_PRINCIPAL_HEADER`, so clients cannot pick a principal.
- Subscriptions are created only through `register` after an authorized read; client
  `subscribe` frames are dropped.
- `register` returns 403 when the socket of `client_id` belongs to another principal,
  and another principal cannot `start` with a `client_id` that still has subscriptions.
- A client `unsubscribe` only removes that socket's own subscriptions.

A full example with D1, auth and sharding: [`cf-worker`](../../examples/cf-worker/README.md).

## Core Types

### `CollectionResponse<T>`

Response shape for collection queries.

```ts
type CollectionResponse<T> = {
  items: T[]
  paging: {
    current: number
    total: number
  }
  cursor: {
    current: string
    next: string
    prev: string
  }
}
```

Use this when a handler returns a list of items with paging and cursor metadata.

When the collection route contains path parameters, every returned item MUST include each route parameter as a same-name field with the same value. For example, `/livequery/category/:category_id/tag/:tag/tasks` MUST return task items with `category_id` and `tag`.

### `DocumentResponse<T>`

Response shape for document queries.

```ts
type DocumentResponse<T> = {
  item: T
}
```

Use this when a handler returns one document.

### `RawRequest`

The request shape expected from a framework adapter before Livequery parsing.

```ts
type RawRequest = {
  path: string
  ref: string
  method: string
  body?: any
  params: Record<string, any>
  query: Record<string, any>
  headers: Map<string, string>
}
```

- `path` is the actual request path, for example `/livequery/posts/p1`.
- `ref` is the route pattern, for example `/livequery/posts/:id`.
- `params` contains framework route params.
- `query` contains parsed query params.
- `headers` is a string map used by handlers such as `WebsocketGateway`.

### `LivequeryRequest<I>`

The normalized request shape created by `LivequeryRequestParser`.

```ts
type LivequeryRequest<I> = {
  keys: Record<string, any>
  path: string
  document_id?: string
  collection: string
  collection_ref: string
  schema: string
  schema_collection_ref: string
  ref: string
  method: string
  body: I
  query: Record<string, any>
}
```

### `LivequeryContext<T>`

The shared context passed through Livequery handlers.

```ts
type LivequeryContext<T = {}> = {
  request: RawRequest
  livequery?: LivequeryRequest<any>
  response?: T
}
```

### `LivequeryHandler<O>`

The common handler contract.

```ts
type LivequeryHandler<O = {}> = {
  handle(ctx: LivequeryContext<O>): any
}
```

Use this interface for parsers, middleware, datasource adapters, auth handlers, and realtime handlers.

## `LivequeryRequestParser`

`LivequeryRequestParser` is the first handler in a typical request pipeline. It reads `ctx.request` and writes `ctx.livequery`.
Use `LivequeryRequestParser.parse(request)` when you need the normalized request object without a handler context.

### When To Use It

Use it inside HTTP framework adapters before invoking datasource or business logic handlers. Downstream handlers should rely on `ctx.livequery` instead of reparsing paths.
Both `request.path` and `request.ref` must start with the `livequery` segment; parsing starts from the segment after it.

### Constructor

```ts
new LivequeryRequestParser()
```

### `parse(request)`

```ts
const livequery = LivequeryRequestParser.parse(rawRequest)
```

### `handle(ctx)`

Parses a raw request into:

- `ref`: actual data reference, for example `posts/p1`.
- `collection`: last segment of `collection_ref`, for example `posts`.
- `collection_ref`: collection reference, for example `posts`.
- `schema`: route-pattern-based collection reference preserving `:`, for example `users/:uid/posts`.
- `schema_collection_ref`: route-pattern-based collection reference, for example `users/uid/posts`.
- `document_id`: document id when the request targets a document.
- `method`: uppercased request method.
- `keys`: route params whose pattern segments begin with `:`.
- `body`, `query`, and original `path`.

It also removes:

- The required first path segment `livequery`.
- Query strings before parsing path segments.
- Realtime suffixes after `~` in the pathname.

Query values are preserved in `query`. A `~` inside the query string is not treated as a realtime suffix.

For Mongo-style datasource adapters, this normalized shape is intentionally enough:

- Use `collection` as the target collection name.
- Use `keys` as the route-derived query filter.
- Use `document_id` for document-shaped routes.
- Use `action` for custom command routes.
- Use `body` and `query` for write payloads and read options.

Adapters should prefer these parsed fields instead of reparsing `collection_ref` or `schema_collection_ref`. `schema` preserves `:` boundaries for cases that still need the route pattern.

### Example

```ts
import { LivequeryRequestParser, type LivequeryContext } from '@livequery/core'

const ctx: LivequeryContext = {
  request: {
    path: '/livequery/posts/p1',
    ref: '/livequery/posts/:id',
    method: 'get',
    params: { id: 'p1' },
    query: {},
    headers: new Map(),
  },
}

new LivequeryRequestParser().handle(ctx)

console.log(ctx.livequery)
// {
//   ref: 'posts/p1',
//   collection_ref: 'posts',
//   schema_collection_ref: 'posts',
//   document_id: 'p1',
//   keys: { id: 'p1' },
//   method: 'GET',
//   ...
// }
```

## `LivequeryDatasource`

`LivequeryDatasource<RouteConfig>` is a type for datasource adapters.

```ts
type LivequeryDatasourceInitConfig<Config> = Config & {
  method: string
  path: string
}

type LivequeryDatasource<RouteConfig> = LivequeryHandler & {
  init(routes: Array<LivequeryDatasourceInitConfig<RouteConfig>>): Promise<void> | void
}
```

### When To Use It

Use this type when implementing an adapter that connects Livequery requests to a database, external API, or framework-specific route system.

A datasource should:

- Implement `handle(ctx)` to process a request.
- Implement `init(routes)` to register route configuration.

### Example

```ts
import type { LivequeryContext, LivequeryDatasource } from '@livequery/core'

type RouteConfig = { table: string }

class MemoryDatasource implements LivequeryDatasource<RouteConfig> {
  #routes = new Map<string, RouteConfig>()

  init(routes: Array<RouteConfig & { method: string; path: string }>) {
    for (const route of routes) {
      this.#routes.set(`${route.method.toUpperCase()} ${route.path}`, route)
    }
  }

  handle(ctx: LivequeryContext) {
    if (!ctx.livequery) return

    ctx.response = {
      item: {
        id: ctx.livequery.document_id,
        ref: ctx.livequery.ref,
      },
    }
  }
}
```

## `WebsocketGateway`

`WebsocketGateway` manages realtime subscriptions and forwards update events. It extends `Subject<UpdatedData>`, so callers can publish updates with `next(update)`.

### When To Use It

Use it when clients need realtime updates for Livequery refs.

Typical flow:

1. A client connects to the WebSocket endpoint.
2. The client starts a socket session.
3. HTTP requests register subscriptions by passing client/gateway headers.
4. Services publish `UpdatedData`.
5. The gateway sends `sync` events to subscribed clients.

### Constructor

```ts
new WebsocketGateway(serverOrPort)
```

- Pass an `http.Server` in Node.js.
- Pass a port number in Bun runtime.

> The WS server runs with `perMessageDeflate` **disabled**. Bun's native `WebSocket` client is incompatible with the `ws` server's permessage-deflate extension and closes such connections abnormally (code `1006`); disabling compression keeps gateway-to-gateway and Bun-client connections stable. Sync payloads are small JSON, so the bandwidth cost is negligible.

### Properties

- `id`: unique gateway id.
- `auth`: token used by trusted gateway-to-gateway connections.

### `handle(ctx)`

Reads:

- `ctx.livequery.ref`
- `x-lcid` or `socket_id`
- `x-lgid`

Then registers a realtime subscription for the current request ref.

### `listen(events)`

Registers one or more realtime subscriptions.

```ts
wsGateway.listen([{
  ref: 'posts',
  client_id: 'client-1',
  gateway_id: wsGateway.id,
  listener_node_id: wsGateway.id,
}])
```

### `unsubscribe_client(socket, body)`

Removes subscriptions for a client by `ref` or `refs`.

### `detach(clientId, refs)`

Removes subscriptions for a client id by one ref or multiple refs without requiring the client socket object.

```ts
wsGateway.detach('client-1', 'posts')
wsGateway.detach('client-1', ['posts', 'comments'])
```

### `link(ref, handler)`

Attaches an observable update stream for a ref that already has subscribers.

```ts
import { Subject } from 'rxjs'

const updates$ = new Subject<any>()

await wsGateway.link('posts', () => updates$)

updates$.next({
  ref: 'posts',
  type: 'modified',
  data: { id: 'p1', title: 'New title' },
})
```

### `connect(url, auth, ondisconnect?)`

Creates an outbound connection to another WebSocket gateway and forwards subscription/sync events.

### `close()`

Closes the WebSocket server, active sockets, subscriptions, update streams, and completes the subject.

### Client Protocol

Client connects to `WEBSOCKET_PATH`, then sends:

```json
{ "event": "start", "data": { "id": "client-1", "auth": "" } }
```

Gateway responds:

```json
{ "event": "hello", "gid": "...", "binary": true }
```

Server update sent to client:

```json
{
  "event": "sync",
  "data": {
    "changes": [
      { "ref": "posts", "type": "modified", "data": { "id": "p1" } }
    ]
  }
}
```

## Helpers

### `hidePrivateFieldsInItem(item)`

Returns a new object with private fields removed. Fields beginning with `_` are removed, except `_id`, which is mapped to `id` when `id` is missing.

```ts
hidePrivateFieldsInItem({ _id: '1', name: 'Alice', _secret: true })
// { id: '1', name: 'Alice' }
```

### `hidePrivateFields(data)`

Sanitizes a plain item, a `DocumentResponse`, or a `CollectionResponse`.

```ts
hidePrivateFields({
  item: { _id: 'p1', title: 'Hello', _internal: true },
})
// { item: { id: 'p1', title: 'Hello' } }
```

### `nodeRequestToWebRequest(req, extraHeaders?)`

Converts a Node.js request with optional `rawBody` into a Web `Request`.

- Uses the `host` header, or `127.0.0.1` as fallback.
- Merges `extraHeaders`.
- Omits body for `GET` and `HEAD`.
- Uses `req.rawBody` for methods that support a body.

### `writeWebResponse(res, response)`

Copies a Web `Response` into a Node.js `ServerResponse`.

- Copies status.
- Copies headers.
- Writes the response body.

## Constants

| Constant | Meaning | Default |
| --- | --- | --- |
| `WEBSOCKET_PATH` | Realtime WebSocket path. Reads `REALTIME_UPDATE_SOCKET_PATH`. | `/livequery/realtime-updates` |
| `NODE_ID` | Random id for this process | random |
| `LIVEQUERY_API_GATEWAY_DEBUG` | Enables gateway logs. Reads the env var of the same name. | false |
| `LIVEQUERY_VARS` | Hono context variable names shared by the middlewares | — |
| `LIVEQUERY_REF_HEADER` / `LIVEQUERY_CHANGE_HEADER` | Headers a service uses to tell its gateway what realtime to do | — |

## Example: service and gateway

A service is a Hono app; a gateway routes to it by path prefix. Both live in
[`@livequery/honojs`](../honojs/README.md), and a full pair that runs on Node and Bun is in
[`examples/api-gateway`](../../examples/api-gateway/README.md):

```ts
// service
app.get('/livequery/tasks', validator(Task), livequery(), d1(), realtime())

// gateway
app.use('*', gateway({ routing, realtime: await realtimeGateway() }))
```

## Environment Variables

```sh
REALTIME_UPDATE_SOCKET_PATH=/livequery/realtime-updates
LIVEQUERY_API_GATEWAY_DEBUG=1
```

## Tests

```sh
bun run build
bun test tests/
bunx tsc -p tests/tsconfig.json --noEmit
```

The test suite covers:

- Public entrypoint exports.
- Request parsing, including nested params, realtime suffixes, and query strings containing `~`.
- API gateway routing, metadata updates, header/body forwarding, error responses, and round-robin.
- Service metadata publishing with `ApiServiceLinker`.
- HTTP discovery registration, auth, namespace/tag filtering, and TTL expiration.
- UDP discovery signatures, TTL, status, and close behavior.
- WebSocket gateway lifecycle, subscriptions, observable links, and gateway-to-gateway forwarding.
- Hono integration and multi-process gateway/service discovery flows.
- Response field sanitization.
- Node/Web HTTP helper conversion.
