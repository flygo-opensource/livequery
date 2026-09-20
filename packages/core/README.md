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
// Node: gateway on `ws`, HTTP/UDP discovery, API gateway and service linker
import {
  ApiGatewayHandler,
  ApiServiceLinker,
  HttpDiscovery,
  WebsocketGateway,
} from '@livequery/core/node'

// UDP LAN discovery (loads @ohayo/udp, so it has its own entry)
import { UdpDiscovery } from '@livequery/core/udp'

// Bun
import { BunWebsocketGateway } from '@livequery/core/bun'

// Cloudflare Workers and Durable Objects
import { HibernatableWebsocketGateway } from '@livequery/core/workers'
```

`ws` and `@ohayo/udp` are optional peer dependencies. Install `ws` to use
`WebsocketGateway` from `/node`, and `@ohayo/udp` to use `@livequery/core/udp`. Importing `/node`
or `/bun` never loads `@ohayo/udp`.

### Migrating from 2.x

3.0 removed the Node adapters from the root entry. Change
`from '@livequery/core'` to `from '@livequery/core/node'` wherever you import
`WebsocketGateway`, `HttpDiscovery`, `ApiGatewayHandler` or `ApiServiceLinker`, import
`UdpDiscovery` from `@livequery/core/udp`, and add `ws` / `@ohayo/udp` to your own dependencies if you use
them. Everything else is unchanged.

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
answered by the runtime (`setWebSocketAutoResponse`) without waking the object.

Trust model:

- Only the Worker reaches the Durable Object; the router forwards WebSocket upgrades
  only, so clients never reach the internal broadcast / subscribe endpoints.
- The router always overwrites `LIVEQUERY_PRINCIPAL_HEADER`, so clients cannot pick a principal.
- Subscriptions are created only through `register` after an authorized read; client
  `subscribe` frames are dropped.
- `register` returns 403 when the socket of `client_id` belongs to another principal,
  and another principal cannot `start` with a `client_id` that still has subscriptions.
- A client `unsubscribe` only removes that socket's own subscriptions.

A full example with D1, auth and sharding: [`cf-worker`](../cf-worker/README.md).

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

## `ApiGatewayHandler`

`ApiGatewayHandler` is an HTTP reverse proxy and route registry for Livequery service nodes.

It can:

- Receive service metadata from `Discovery<ServiceApiMetadata>` implementations. The default is `HttpDiscovery`.
- Register routes by method and path.
- Forward HTTP requests to online service nodes.
- Round-robin between multiple hosts for the same route.
- Connect to service WebSocket gateways when service metadata includes `ws`.
- Isolate a node the instant it fails — an HTTP transport error/timeout or a dropped WS link takes the **whole node** out of rotation while a healthy node still exists — and bring it back automatically on recovery.
- Bound a hung upstream with a configurable request timeout so one stuck service can't hold a request (and its sockets) open forever.

### When To Use It

Use this in a gateway process. Public HTTP requests enter the gateway and are forwarded to service nodes discovered at runtime.

### Constructor

```ts
new ApiGatewayHandler({
  node_id?: string
  discovery?: Discovery<ServiceApiMetadata>
  ws?: WebsocketGateway
  timeoutMs?: number
})
```

- `node_id`: stable id for this gateway. A random id is used when omitted.
- `discovery`: custom discovery instance, useful in tests or custom network setups.
- `ws`: realtime gateway used for cross-gateway WebSocket forwarding.
- `timeoutMs`: upstream request timeout in milliseconds. Defaults to `LIVEQUERY_GATEWAY_TIMEOUT` (in **seconds**, default `30`).

`discovery` is structurally typed. It may be an `HttpDiscovery` from `@ohayo/http`, a
`UdpDiscovery` from `@ohayo/udp`, the backward-compatible discovery exported by core, or a test
implementation. The instance only needs to implement the shared `Discovery<T>` contract.

### `register(options)`

Registers service routes manually.

```ts
gateway.register({
  node_id: 'service-1',
  hostname: '127.0.0.1',
  port: 3001,
  paths: [{ method: 'GET', path: 'livequery/posts' }],
})
```

### `deregister(node_id)`

Removes all route hosts for a service node.

Use this when a service goes offline or when a forwarded request fails.

### `fetch(request)`

Accepts a Web `Request`, forwards it to the selected service, and returns a Web `Response`.

```ts
const response = await gateway.fetch(
  new Request('http://gateway/livequery/posts')
)
```

### `fetch(req, res, extraHeaders?)`

Accepts Node.js `IncomingMessage` and `ServerResponse`.

```ts
import * as http from 'http'
import { ApiGatewayHandler } from '@livequery/core/node'

const gateway = new ApiGatewayHandler({})

http.createServer((req, res) => {
  gateway.fetch(req as any, res)
}).listen(3000)
```

### `fetchRequest(request)`

Alias for `fetch(request)`.

### `close()`

Unsubscribes from discovery, closes discovery sockets, disconnects service subscriptions, and clears service state.

### Error Responses

- Missing route: `404 { error: { status: 404, code: 'API_NOT_FOUND', message } }`
- Route is known but has **no registered host**: `503 { error: { status: 503, code: 'API_OFFLINE', message } }`
- Forwarded request could not reach the upstream: `502 { error: { status: 502, code: 'SERVICE_API_OFFLINE', message } }`
- Upstream accepted the connection but did not respond within the timeout: `504 { error: { status: 504, code: 'SERVICE_API_TIMEOUT', message } }`

> A node that is merely *offline* (transiently unreachable but still registered) does **not** produce a `503` — the gateway keeps trying it. See **Offline Isolation & Failover**.

### Offline Isolation & Failover

The gateway distinguishes a node that is **offline** (registered but transiently unreachable — e.g. mid-restart) from one that is **removed** (deregistered and gone from rotation).

**Detection** — a node is isolated the moment it fails:

- **HTTP:** a forwarded `fetch` throws (connection refused/reset) or blows the timeout. The **whole node** is isolated — every route it serves, not only the one that failed.
- **WebSocket:** its WS bridge drops → the node is isolated with WS precedence.

**Routing** (`fetch`):

- Route has **online** hosts → round-robin among them; isolated nodes are skipped.
- **No** host online → round-robin across **all** registered hosts anyway (last resort). An offline node may just be flapping/restarting and there is no healthy alternative to protect, so the gateway keeps dialing it; the first that answers wins. A single-node route is therefore **never** hard-failed with `503`.
- Route has **no registered host at all** → `503`.

**Recovery** — isolation lifts automatically:

- A successful upstream response immediately clears HTTP isolation.
- A fresh discovery heartbeat clears HTTP isolation (proof the process is alive).
- WS isolation clears only on a real WS **reconnect** — a heartbeat does **not** undo it. Once the WS bridge exhausts its retries the node is fully removed.

**Timeout** — every forwarded request is bounded by `timeoutMs` (default 30s; env `LIVEQUERY_GATEWAY_TIMEOUT` in seconds). A hung upstream — one that accepts the socket but never answers — is aborted → `504` and isolated, instead of holding the request and its file descriptors open indefinitely.

## `ApiServiceLinker`

`ApiServiceLinker` publishes service metadata so gateways can discover and route to a service node.

### When To Use It

Use this inside each service process that should be discoverable by an `ApiGatewayHandler`.

### Constructor

```ts
new ApiServiceLinker({
  paths: [{ method: 'GET', path: 'livequery/posts' }],
  node_id?: 'service-1',
  discovery?: customDiscovery,
  ws?: websocketGateway,
})
```

The `discovery` option uses the same structural contract as `ApiGatewayHandler`. Gateway and service
can therefore receive matching instances from `@ohayo/http` or `@ohayo/udp` without an adapter.

### `start(name, port)`

Broadcasts service metadata through discovery. The default service discovery is `HttpDiscovery` in service-side mode: it reads `OHAYO_API_GATEWAY`, sends `POST /register`, heartbeats periodically, and sends best-effort `DELETE /register/:node_id` on close.

```ts
const linker = new ApiServiceLinker({
  paths: [{ method: 'GET', path: 'livequery/posts' }],
})

linker.start('posts-service', 3001)
```

When the service sees a gateway in the same namespace, it refreshes its metadata version and broadcasts again.

### Using Ohayo Packages Directly

Livequery does not require a discovery instance to be constructed by `@livequery/core`. HTTP and UDP
implement the same public shape:

```sh
bun add @ohayo/http   # HTTP registry, heartbeat, TTL and graceful deregistration
bun add @ohayo/udp    # UDP multicast / explicit-peer discovery
```

```ts
type Discovery<T> = Observable<DiscoveryMessage<T>> & {
  broadcast(message: DiscoveryMessage<T>): Promise<void>
  close(): void
}
```

HTTP registry example:

```ts
import { HttpDiscovery } from '@ohayo/http'
import {
  ApiGatewayHandler,
  ApiServiceLinker,
  type ServiceApiMetadata,
} from '@livequery/core/node'

const gatewayDiscovery = new HttpDiscovery<ServiceApiMetadata>({
  mode: 'server',
  namespace: 'default',
  tags: ['livequery'],
  node_id: 'gateway-1',
  key: process.env.OHAYO_DISCOVERY_KEY,
  port: 12001,
})

const gateway = new ApiGatewayHandler({ discovery: gatewayDiscovery })

const serviceDiscovery = new HttpDiscovery<ServiceApiMetadata>({
  mode: 'client',
  namespace: 'default',
  tags: ['livequery'],
  node_id: 'posts-service-1',
  key: process.env.OHAYO_DISCOVERY_KEY,
  servers: ['10.0.0.10:12001'],
})

const service = new ApiServiceLinker({
  paths: [{ method: 'GET', path: 'livequery/posts' }],
  discovery: serviceDiscovery,
})

service.start('posts-service', 3001)
```

For zero-config LAN discovery, replace both `HttpDiscovery` instances with `UdpDiscovery` from
`@ohayo/udp`, keeping the same `namespace`, key, port, and compatible required tags:

```ts
import { UdpDiscovery } from '@ohayo/udp'

const gatewayDiscovery = new UdpDiscovery<ServiceApiMetadata>({
  namespace: 'default',
  tags: ['livequery'],
  node_id: 'gateway-1',
})

const serviceDiscovery = new UdpDiscovery<ServiceApiMetadata>({
  namespace: 'default',
  tags: ['livequery'],
  node_id: 'posts-service-1',
})
```

The linker owns the supplied discovery lifecycle: calling `gateway.close()` or `service.close()`
also closes that discovery instance. Do not share one instance between independently managed
linkers.

### `close()`

Unsubscribes from discovery and closes the discovery instance.

## `HttpDiscovery`

`HttpDiscovery<T>` is the production-oriented Ohayo discovery transport. It uses a small HTTP registry so service nodes can register with gateway nodes without relying on multicast.

Both HTTP and UDP discovery use the same envelope:

```ts
type DiscoveryMessage<T> = {
  node_id: string
  namespace: string
  tags: string[]
  version: string
  created_at: number
  seq: number
  data: T
  remote_host?: string
}
```

### Constructor

```ts
new HttpDiscovery<T>({
  mode: 'server' | 'client'
  namespace: string
  tags: string[]
  node_id?: string
  key?: string
  // server mode
  host?: string
  port?: number
  ttlMs?: number
  // client mode
  servers?: string[]
  heartbeatMs?: number
  requestTimeoutMs?: number
  retryAttempts?: number
})
```

- `mode`: required role. `server` opens a registry; `client` registers with configured servers.
- `namespace`: exact discovery namespace. Inbound and outbound messages must match.
- `tags`: required tags. Messages may contain extra tags, but must contain all configured tags.
- `node_id`: optional fixed node id. Outbound messages with a different id are rejected; inbound messages from the same id are ignored.
- `key`: bearer token for registry requests. Defaults to `OHAYO_DISCOVERY_KEY`.
- `host`, `port`, `ttlMs`: server-mode bind and lease options.
- `servers`: required non-empty client-mode registry list. It is always supplied to the constructor and is not read from environment variables.
- `heartbeatMs`, `requestTimeoutMs`, `retryAttempts`: client-mode delivery options.

### Gateway-Side Registry

Gateway-side instances keep an in-memory registry and expose:

- `POST /register`: authenticated registration body is a `DiscoveryMessage<T>`.
- `DELETE /register/:node_id`: authenticated graceful deregistration.
- `GET /health`: unauthenticated health probe.
- `GET /nodes`: authenticated snapshot of registered nodes.

```ts
const gatewayDiscovery = new HttpDiscovery<ServiceApiMetadata>({
  mode: 'server',
  namespace: 'default',
  tags: ['livequery'],
  node_id: 'gateway-1',
  port: 12001,
})
```

Accepted registrations are emitted through the observable. The transport keeps app metadata inside `data` and may attach `remote_host` at the envelope level.

### Service-Side Client

Client-mode instances send registrations to every explicit constructor `servers` entry.

```ts
const serviceDiscovery = new HttpDiscovery<ServiceApiMetadata>({
  mode: 'client',
  namespace: 'default',
  tags: ['livequery'],
  node_id: 'service-1',
  servers: ['127.0.0.1:12001', '127.0.0.1:12002'],
})

await serviceDiscovery.broadcast({
  node_id: 'service-1',
  namespace: 'default',
  tags: ['livequery', 'service'],
  version: String(Date.now()),
  created_at: Date.now(),
  seq: 1,
  data: {
    role: 'service',
    name: 'posts',
    host: '127.0.0.1',
    port: 3001,
    paths: [{ method: 'GET', path: 'livequery/posts' }],
    linked: [],
  },
})
```

HTTP discovery filters inbound and outbound messages by namespace and contains-all tags. It authenticates registry requests with `Authorization: Bearer <OHAYO_DISCOVERY_KEY>`, retries failed registrations with backoff, refreshes service registrations with heartbeat, emits `{ data: { status: 'offline' } }` after TTL expiry, and sends best-effort deregistration on close.

## `UdpDiscovery`

`UdpDiscovery<T>` is a compatibility re-export from `@ohayo/udp`. Core does not
maintain its own UDP sockets or packet codec. The transport uses UDP multicast
or explicit peers, msgpack packet encoding, and HMAC SHA-256 signatures. New
integrations should import `@ohayo/udp` directly; see the workspace
`examples/udp-auto-discovery` E2E.

### When To Use It

Use it when gateway and service nodes need local-network discovery without an HTTP registry. It is useful for development, LAN deployments, and environments where multicast is allowed. `ApiGatewayHandler` and `ApiServiceLinker` default to `HttpDiscovery`; pass a `UdpDiscovery` instance explicitly if you want UDP.

### Constructor

```ts
new UdpDiscovery<T>({
  namespace: string
  tags: string[]
  node_id?: string
  key?: string
  port?: number
  peers?: string[]
  multicastAddress?: string
  packetTtlMs?: number
  broadcastCopies?: number
})
```

- `namespace`, `tags`, and `node_id` follow the same contract as `HttpDiscovery`.
- `key`: HMAC signing key. Explicit configuration is recommended; direct
  `@ohayo/udp` use otherwise falls back to `OHAYO_DISCOVERY_KEY` and then its
  development default.
- `port`: UDP send/receive port. Defaults to `OHAYO_DISCOVERY_PORT`.
- `peers`: extra peer IPs or `/24` prefixes. Defaults to `OHAYO_UDP_WHITELIST_ADDRESS`.
- `multicastAddress`: multicast group; defaults to `OHAYO_UDP_MULTICAST_ADDRESS`
  or `239.0.1.1`.
- `packetTtlMs`: anti-replay packet window. Defaults to 30 seconds.
- `broadcastCopies`: number of copies per broadcast; defaults to 3.

All trusted nodes must use the same key, namespace, and compatible tags.

### `status$`

Observable lifecycle status:

- `not_ready`
- `ready`
- `closed`

### Packet Format

UDP packets are msgpack-encoded:

```ts
type UdpDiscoveryPacket<T> = {
  version: 1
  sender_id: string
  timestamp: number
  message: DiscoveryMessage<T>
  signature: string
}
```

`signature` is `hmac_sha256(pack(unsigned_packet), key)`. Packets older than `packetTtlMs`, packets with invalid signatures, malformed envelopes, wrong namespaces, or missing required tags are ignored.

UDP discovery does not dedupe and does not compare `seq`; duplicate valid packets are emitted and consumers decide how to handle staleness.

### `broadcast(message, targetIp?)`

Broadcasts a `DiscoveryMessage<T>`.

If `targetIp` is omitted, the packet is sent to multicast, configured peers, and local multicast. If `targetIp` is provided, the packet is sent only to that address or list of addresses.

```ts
await discovery.broadcast({
  node_id: 'service-1',
  namespace: 'default',
  tags: ['livequery', 'service'],
  version: String(Date.now()),
  created_at: Date.now(),
  seq: 1,
  data: {
    role: 'service',
    name: 'posts',
  },
})
```

### `close()`

Closes sockets and completes the observable streams.

### Example

```ts
import type { DiscoveryMessage } from '@livequery/core'
import { UdpDiscovery } from '@livequery/core/udp'

type Metadata = { role: 'service' | 'gateway'; name: string }

const discovery = new UdpDiscovery<Metadata>({
  namespace: 'default',
  tags: ['livequery'],
  node_id: 'service-1',
  key: 'shared-secret',
})

discovery.subscribe(message => {
  console.log('node online', message.node_id, message.data)
})

const message: DiscoveryMessage<Metadata> = {
  node_id: 'service-1',
  namespace: 'default',
  tags: ['livequery', 'service'],
  version: String(Date.now()),
  created_at: Date.now(),
  seq: 1,
  data: { role: 'service', name: 'posts' },
}

await discovery.broadcast(message)
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
| `API_GATEWAY_NAMESPACE` | Namespace used by gateway and service metadata filtering. Reads `OHAYO_DISCOVERY_NAMESPACE`. | `default` |
| `OHAYO_DISCOVERY_KEY` | Shared bearer/HMAC key for Ohayo discovery | `livequery` |
| `OHAYO_DISCOVERY_PORT` | HTTP registry port and default UDP discovery port | `12001` |
| `OHAYO_API_GATEWAY` | Comma-separated HTTP discovery registries for services | empty |
| `OHAYO_WS_GATEWAY` | Reserved comma-separated websocket gateway list | empty |
| `API_GATEWAY_MULTICAST_PORT` | UDP discovery port. Reads `OHAYO_DISCOVERY_PORT`. | `11001` |
| `API_GATEWAY_MULTICAST_ADDRESS` | UDP multicast address. Reads `OHAYO_UDP_MULTICAST_ADDRESS`. | `239.0.1.1` |
| `API_GATEWAY_WHITELIST_ADDRESS` | Additional peer IPs or prefixes. Reads `OHAYO_UDP_WHITELIST_ADDRESS`. | empty |
| `NODE_ID` | Runtime node id | random UUID |
| `LIVEQUERY_API_GATEWAY_DEBUG` | Enables gateway logs | false |
| `WEBSOCKET_PATH` | Realtime WebSocket path | `/livequery/realtime-updates` |
| `LIVEQUERY_GATEWAY_TIMEOUT` | Gateway upstream-request timeout, in **seconds** (non-positive/invalid → default) | `30` |

## Example: Service Process

```ts
import * as http from 'http'
import {
  ApiServiceLinker,
  LivequeryRequestParser,
  hidePrivateFields,
  type LivequeryContext,
} from '@livequery/core/node'

const parser = new LivequeryRequestParser()

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const id = url.pathname.split('/').at(-1)

  const ctx: LivequeryContext = {
    request: {
      path: url.pathname,
      ref: '/livequery/posts/:id',
      method: req.method ?? 'GET',
      params: { id },
      query: Object.fromEntries(url.searchParams),
      headers: new Map(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
    },
  }

  parser.handle(ctx)

  ctx.response = hidePrivateFields({
    item: { _id: ctx.livequery?.document_id, title: 'Hello', _internal: true },
  })

  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(ctx.response))
})

server.listen(3001)

new ApiServiceLinker({
  paths: [{ method: 'GET', path: 'livequery/posts/:id' }],
}).start('posts-service', 3001)
```

## Example: Gateway Process

```ts
import * as http from 'http'
import {
  ApiGatewayHandler,
  WebsocketGateway,
} from '@livequery/core/node'

const server = http.createServer()
const ws = new WebsocketGateway(server)
const gateway = new ApiGatewayHandler({ ws })

server.on('request', (req, res) => {
  gateway.fetch(req as any, res)
})

server.listen(3000)
```

## Environment Variables

```sh
OHAYO_DISCOVERY_NAMESPACE=default
OHAYO_DISCOVERY_KEY=livequery
OHAYO_DISCOVERY_PORT=12001
OHAYO_API_GATEWAY=10.0.0.10:12001,10.0.0.11:12001
OHAYO_SERVICE_HOST=10.0.0.20
OHAYO_UDP_MULTICAST_ADDRESS=239.0.1.1
OHAYO_UDP_WHITELIST_ADDRESS=192.168.1
REALTIME_UPDATE_SOCKET_PATH=/livequery/realtime-updates
LIVEQUERY_API_GATEWAY_DEBUG=1
LIVEQUERY_GATEWAY_TIMEOUT=30
```

`OHAYO_UDP_WHITELIST_ADDRESS` accepts:

- A full IP address, for example `192.168.1.10`.
- A three-part prefix, for example `192.168.1`, expanded to `192.168.1.0` through `192.168.1.255`.

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
