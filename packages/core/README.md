# @livequery/core

`@livequery/core` is the framework-agnostic runtime layer for Livequery.

It provides the shared primitives used by HTTP adapters, data-source adapters, API gateway processes, service processes, and realtime synchronization layers. The package does not run database queries by itself and does not require a specific HTTP framework.

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
- Discover gateway and service nodes over UDP.
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

## Public Entry Point

```ts
import {
  ApiGatewayHandler,
  ApiServiceLinker,
  LivequeryRequestParser,
  UdpDiscovery,
  WebsocketGateway,
  hidePrivateFields,
} from '@livequery/core'
```

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
  collection_ref: string
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
  handle(ctx: LivequeryContext<O>): Promise<void> | void
}
```

Use this interface for parsers, middleware, datasource adapters, auth handlers, and realtime handlers.

## `LivequeryRequestParser`

`LivequeryRequestParser` is the first handler in a typical request pipeline. It reads `ctx.request` and writes `ctx.livequery`.

### When To Use It

Use it inside HTTP framework adapters before invoking datasource or business logic handlers. Downstream handlers should rely on `ctx.livequery` instead of reparsing paths.

### Constructor

```ts
new LivequeryRequestParser(ws?)
```

The optional `ws` parameter accepts a `WebsocketGateway`, but parsing itself does not require it.

### `handle(ctx)`

Parses a raw request into:

- `ref`: actual data reference, for example `posts/p1`.
- `collection_ref`: collection reference, for example `posts`.
- `schema_collection_ref`: route-pattern-based collection reference, for example `users/uid/posts`.
- `document_id`: document id when the request targets a document.
- `method`: uppercased request method.
- `keys`, `body`, `query`, and original `path`.

It also removes:

- The Livequery path prefix when present.
- Query strings.
- Realtime suffixes after `~`.

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

- Receive service metadata from `UdpDiscovery`.
- Register routes by method and path.
- Forward HTTP requests to online service nodes.
- Round-robin between multiple hosts for the same route.
- Connect to service WebSocket gateways when service metadata includes `ws`.

### When To Use It

Use this in a gateway process. Public HTTP requests enter the gateway and are forwarded to service nodes discovered at runtime.

### Constructor

```ts
new ApiGatewayHandler({
  nodeId?: string
  discovery?: UdpDiscovery<ServiceApiMetadata>
  ws?: WebsocketGateway
})
```

- `nodeId`: stable id for this gateway. A random id is used when omitted.
- `discovery`: custom discovery instance, useful in tests or custom network setups.
- `ws`: realtime gateway used for cross-gateway WebSocket forwarding.

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
import { ApiGatewayHandler } from '@livequery/core'

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

- Missing route: `404 { error: { status: 404, code: 'API_NOT_FOUND' } }`
- Route exists but no host is online: `503 { error: { status: 503, code: 'API_OFFLINE' } }`
- Forwarded service request fails: `502 { error: { status: 502, code: 'SERVICE_API_OFFLINE' } }`

## `ApiServiceLinker`

`ApiServiceLinker` publishes service metadata so gateways can discover and route to a service node.

### When To Use It

Use this inside each service process that should be discoverable by an `ApiGatewayHandler`.

### Constructor

```ts
new ApiServiceLinker({
  paths: [{ method: 'GET', path: 'livequery/posts' }],
  nodeId?: 'service-1',
  discovery?: customDiscovery,
  ws?: websocketGateway,
})
```

### `start(name, port)`

Broadcasts service metadata through UDP discovery.

```ts
const linker = new ApiServiceLinker({
  paths: [{ method: 'GET', path: 'livequery/posts' }],
})

linker.start('posts-service', 3001)
```

When the service sees a gateway in the same namespace, it refreshes its metadata version and broadcasts again.

### `close()`

Unsubscribes from discovery and closes the discovery instance.

## `UdpDiscovery`

`UdpDiscovery<T>` is an observable UDP discovery layer. It sends and receives msgpack packets signed with HMAC SHA-256.

### When To Use It

Use it when gateway and service nodes need to discover each other without a central registry. `ApiGatewayHandler` and `ApiServiceLinker` create a default instance when no custom discovery is provided.

### Constructor

```ts
const discovery = new UdpDiscovery<MyNode>({
  key: 'shared-secret',
  port: 11001,
})
```

All trusted nodes must use the same key.

### `status$`

Observable lifecycle status:

- `not_ready`
- `ready`
- `closed`

### `broadcast(node, targetIp?)`

Broadcasts a node metadata packet.

If `targetIp` is omitted, the packet is sent to configured multicast peers and local multicast. If `targetIp` is provided, the packet is sent only to that address or list of addresses.

```ts
await discovery.broadcast({
  node_id: 'service-1',
  namespace: 'default',
  version: Date.now(),
  role: 'service',
})
```

### `close()`

Closes sockets and completes the observable streams.

### Example

```ts
import { UdpDiscovery, type UdpDiscoveryNode } from '@livequery/core'

type Node = UdpDiscoveryNode & { role: 'service' | 'gateway' }

const discovery = new UdpDiscovery<Node>({ key: 'livequery/' })

discovery.subscribe(node => {
  console.log('node online', node)
})

await discovery.broadcast({
  node_id: 'service-1',
  namespace: 'default',
  version: Date.now(),
  role: 'service',
})
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
| `API_GATEWAY_NAMESPACE` | Namespace used by gateway and service metadata filtering | `default` |
| `LIVEQUERY_MAGIC_KEY` | Livequery path prefix and default discovery key suffix | `livequery/` |
| `API_GATEWAY_MULTICAST_PORT` | UDP discovery port | `11001` |
| `API_GATEWAY_MULTICAST_ADDRESS` | UDP multicast address | `239.0.1.1` |
| `API_GATEWAY_WHITELIST_ADDRESS` | Additional peer IPs or prefixes | empty |
| `NODE_ID` | Runtime node id | random UUID |
| `LIVEQUERY_API_GATEWAY_DEBUG` | Enables gateway logs | false |
| `WEBSOCKET_PATH` | Realtime WebSocket path | `/livequery/realtime-updates` |

## Example: Service Process

```ts
import * as http from 'http'
import {
  ApiServiceLinker,
  LivequeryRequestParser,
  hidePrivateFields,
  type LivequeryContext,
} from '@livequery/core'

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
} from '@livequery/core'

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
API_GATEWAY_NAMESPACE=default
LIVEQUERY_MAGIC_KEY=livequery
UDP_PUBLIC_PORT=11001
UDP_MULTICAST_ADDRESS=239.0.1.1
UDP_WHITELIST_ADDRESS=192.168.1
REALTIME_UPDATE_SOCKET_PATH=/livequery/realtime-updates
LIVEQUERY_API_GATEWAY_DEBUG=1
LIVEQUERY_UDP_DEBUG=1
```

`UDP_WHITELIST_ADDRESS` accepts:

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
- Request parsing.
- API gateway routing, metadata updates, error responses, and round-robin.
- UDP discovery signatures, TTL, status, and close behavior.
- WebSocket gateway lifecycle.
- Response field sanitization.
- Node/Web HTTP helper conversion.
