# @livequery/rest

`@livequery/rest` is a REST + WebSocket transporter for `@livequery/core`.

It adapts the `LivequeryTransporter` interface to:

- HTTP requests for `query`, `add`, `update`, `delete`, and `trigger`
- optional WebSocket subscriptions for realtime collection updates
- request/response hooks for auth, caching, logging, or mocking

This package does not implement local cache or collection state management. That stays in `@livequery/core`. This package is only the transport layer between a livequery client and your backend.

## Installation

```bash
npm install @livequery/rest
```

```bash
bun add @livequery/rest
```

## What It Implements

`RestTransporter` implements the `LivequeryTransporter` contract from `@livequery/core`:

- `query()` returns an `Observable<Partial<LivequeryQueryResult>>`
- `add()` sends `POST`
- `update()` sends `PATCH`
- `delete()` sends `DELETE`
- `trigger()` sends `POST /<ref>/~<action>`

When a WebSocket endpoint is configured, `query()` can also attach a realtime subscription and merge server-pushed `DataChangeEvent`s into the observable stream.

## Quick Start

### REST only

```ts
import { RestTransporter } from '@livequery/rest'

const transporter = new RestTransporter({
  api: 'https://api.example.com'
})
```

### REST + realtime

```ts
import { RestTransporter } from '@livequery/rest'

const transporter = new RestTransporter({
  api: 'https://api.example.com',
  ws: 'wss://api.example.com/ws'
})
```

### With `@livequery/core`

```ts
import { LivequeryCore } from '@livequery/core'
import { RestTransporter } from '@livequery/rest'

const transporter = new RestTransporter({
  api: 'https://api.example.com',
  ws: 'wss://api.example.com/ws'
})

const core = new LivequeryCore({
  storage,
  transporters: {
    rest: transporter
  }
})
```

## Constructor

```ts
type RestTransporterConfig = {
  api: string
  ws?: string
  onRequest?: (
    request: RestTransporterRequest & { ref: string }
  ) =>
    | void
    | Partial<RestTransporterRequest & { response?: LivequeryResult<any> }>
    | Promise<void | Partial<RestTransporterRequest & { response?: LivequeryResult<any> }>>
  onResponse?: (
    request: RestTransporterRequest & { ref: string },
    response: LivequeryResult<any>
  ) => void | Promise<void>
}
```

### Options

| Option | Type | Description |
| --- | --- | --- |
| `api` | `string` | Base HTTP URL used for all REST calls. |
| `ws` | `string` | Optional WebSocket endpoint for realtime sync. |
| `onRequest` | `function` | Optional interceptor before `fetch()`. Can override request fields or return a fake response. |
| `onResponse` | `function` | Optional hook called after the response is resolved. |

## Request Model

Outgoing requests use this shape internally:

```ts
type RestTransporterRequest = {
  url: string
  method: string
  query?: Record<string, any>
  body?: Record<string, any> | string
  headers?: Record<string, string | undefined>
}
```

The transporter builds URLs like this:

```text
<api>/<ref>
<api>/<ref>?<query>
<api>/<ref>/~<action>
```

Examples:

```text
GET    /users
GET    /users/123
POST   /users
PATCH  /users/123
DELETE /users/123
POST   /users/~ban
```

## Hooks

### `onRequest`

Use `onRequest` to:

- inject auth headers
- override request body or URL
- short-circuit requests from cache
- mock server responses in tests

```ts
const transporter = new RestTransporter({
  api: 'https://api.example.com',
  ws: 'wss://api.example.com/ws',
  onRequest: async ({ headers }) => {
    const token = await getAccessToken()

    return {
      headers: {
        ...headers,
        Authorization: `Bearer ${token}`
      }
    }
  }
})
```

To skip the network completely, return a `response`:

```ts
const transporter = new RestTransporter({
  api: 'https://api.example.com',
  onRequest: ({ ref }) => {
    const cached = cache.get(ref)
    if (!cached) return

    return {
      response: {
        data: cached
      }
    }
  }
})
```

### `onResponse`

Use `onResponse` for logging, metrics, or centralized error inspection:

```ts
const transporter = new RestTransporter({
  api: 'https://api.example.com',
  onResponse: async (request, response) => {
    if (response.error) {
      console.error('Livequery REST error', {
        url: request.url,
        method: request.method,
        error: response.error
      })
    }
  }
})
```

## REST Response Contract

The transporter expects your backend to return a `LivequeryResult<T>` envelope:

```ts
type LivequeryResult<T> = {
  data: T
  error?: {
    code: string
    message: string
  }
}
```

### Collection query response

For collection reads, `data` should look like:

```ts
type LivequeryCollectionResponse<T> = {
  summary?: Record<string, any>
  items: T[]
  subscription_token?: string
  count?: {
    prev: number
    next: number
    total: number
    current: number
  }
  has?: {
    prev: boolean
    next: boolean
  }
  cursor?: {
    first: string
    last: string
  }
}
```

Example:

```json
{
  "data": {
    "items": [
      { "id": "u1", "name": "Ada" },
      { "id": "u2", "name": "Linus" }
    ],
    "summary": {
      "active": 2
    },
    "count": {
      "prev": 0,
      "next": 20,
      "current": 2,
      "total": 22
    },
    "has": {
      "prev": false,
      "next": true
    },
    "cursor": {
      "first": "cursor-1",
      "last": "cursor-2"
    },
    "subscription_token": "rt_abc123"
  }
}
```

### Single document response

For document reads, `data` should contain `item`:

```json
{
  "data": {
    "item": {
      "id": "u1",
      "name": "Ada"
    }
  }
}
```

### Create response

`add()` accepts either of these backend shapes:

```json
{
  "data": {
    "item": {
      "id": "u1",
      "name": "Ada"
    }
  }
}
```

```json
{
  "data": {
    "id": "u1",
    "name": "Ada"
  }
}
```

## Query Output Shape

`query()` converts server data into the shape expected by `@livequery/core`:

```ts
type LivequeryQueryResult = {
  changes: DataChangeEvent[]
  summary: Record<string, any>
  paging: {
    total: number
    current: number
    next?: { count: number; cursor: string }
    prev?: { count: number; cursor: string }
  }
  source: 'query' | 'realtime' | 'action'
  error: { code: string; message: string }
}
```

Collection responses are converted to `added` events for each returned item. Document responses are converted to a single `added` event for the returned document.

## Realtime

If `ws` is provided, the transporter creates a `Socket` instance and adds these headers to REST calls:

- `socket_id`
- `x-lcid`
- `x-lgid`

This lets your backend bind the HTTP query to the active realtime session.

### Realtime flow

1. A collection query returns `subscription_token`.
2. The transporter forwards that token to the socket with a `subscribe` event.
3. The socket listens for server `sync` messages.
4. Incoming changes are emitted as `DataChangeEvent`s with `source: 'realtime'`.

Realtime listening is only attached for standard collection queries. It is skipped when:

- no `ws` endpoint is configured
- the request is a cursor query using `:after`
- the request is a cursor query using `:before`
- the request is an around query using `:around`

### WebSocket protocol expected by `Socket`

When the socket opens, it sends:

```json
{ "event": "start", "data": { "id": "<client_id>" } }
```

It also sends a heartbeat every 60 seconds:

```json
{ "event": "ping" }
```

To subscribe a collection query, it sends:

```json
{ "event": "subscribe", "data": { "realtime_token": "<token>" } }
```

The server should respond with a hello message containing the gateway id:

```json
{ "event": "hello", "gid": "gateway-1" }
```

Realtime sync messages should look like:

```json
{
  "event": "sync",
  "data": {
    "changes": [
      {
        "ref": "users",
        "id": "u1",
        "type": "modified",
        "data": { "name": "Ada Lovelace" }
      }
    ]
  }
}
```

Each sync change is routed to `listen(ref)` subscribers and normalized to:

```ts
type DataChangeEvent = {
  collection_ref: string
  id: string
  type: 'added' | 'removed' | 'modified'
  data?: Record<string, any>
}
```

## Public API

### `RestTransporter`

```ts
import { RestTransporter } from '@livequery/rest'
```

Methods:

- `query({ ref, filters })`
- `add(ref, data)`
- `update(collectionRef, id, data)`
- `delete(collectionRef, id)`
- `trigger({ ref, action, payload })`

### `Socket`

```ts
import { Socket } from '@livequery/rest'
```

The socket class is exported for low-level integrations and debugging.

Example:

```ts
const socket = new Socket('wss://api.example.com/ws')

socket.listen('users').subscribe(change => {
  console.log(change)
})

socket.stop()
```

## Error Handling

If `fetch()` throws or the backend returns an error envelope, the transporter surfaces it as:

```ts
{
  error: {
    code: string,
    message: string
  }
}
```

For `query()`, errors are emitted as an observable result with `source: 'query'`.

For `add()`, `update()`, `delete()`, and `trigger()`, errors are thrown as rejected promises.

## Build

```bash
bun run build
```

Build steps:

- clean `dist/`
- bundle ESM output with Bun
- generate `.d.ts` files with TypeScript

## License

ISC
