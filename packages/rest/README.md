# @livequery/rest

`@livequery/rest` is the REST and optional WebSocket transport adapter for `@livequery/client`.

Use this package when your application state is managed by `@livequery/client`, but the remote backend is exposed through HTTP endpoints and, optionally, a realtime WebSocket gateway.

This package is transport-only. It does not implement local cache, optimistic state, collection modes, or reactive document state. Those responsibilities stay in `@livequery/client`.

## What It Does

`RestTransporter` implements the `LivequeryTransporter` contract:

- `query()` performs HTTP `GET` requests and emits `LivequeryQueryResult` changes.
- `add()` performs HTTP `POST` requests.
- `update()` performs HTTP `PATCH` requests.
- `delete()` performs HTTP `DELETE` requests.
- `trigger()` performs action calls through `POST /<ref>/~<action>`.
- When `ws` is configured, `query()` can merge server-pushed realtime changes from `Socket`.

`Socket` manages the WebSocket connection, client id, gateway handshake, subscriptions, reconnect loop, and JSON/MessagePack message parsing.

## Installation

```bash
npm install @livequery/rest
```

```bash
bun add @livequery/rest
```

## Basic Usage

### REST Only

```ts
import { RestTransporter } from '@livequery/rest'

const transporter = new RestTransporter({
  api: 'https://api.example.com'
})
```

### REST + Realtime

```ts
import { RestTransporter } from '@livequery/rest'

const transporter = new RestTransporter({
  api: 'https://api.example.com',
  ws: 'wss://api.example.com/ws'
})
```

### With `@livequery/client`

Create one transporter per backend boundary and reuse it in a shared `LivequeryClient`.

```ts
import { LivequeryClient } from '@livequery/client'
import { RestTransporter } from '@livequery/rest'

const transporter = new RestTransporter({
  api: 'https://api.example.com',
  ws: 'wss://api.example.com/ws'
})

const client = new LivequeryClient({
  storage,
  transporters: {
    rest: transporter
  }
})
```

## Configuration

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

| Option | Required | Meaning |
| --- | --- | --- |
| `api` | Yes | Base HTTP URL used for all REST calls, for example `https://api.example.com`. Trailing slashes are normalized. |
| `ws` | No | WebSocket endpoint for realtime sync. When omitted, the package works as a REST-only transporter. |
| `onRequest` | No | Hook called before `fetch()`. Use it to add headers, override request fields, or return a fake `response` to skip the network. |
| `onResponse` | No | Hook called after a network or fake response is available. Use it for logging, metrics, error inspection, or tracing. |

## Request Model

Outgoing requests use this internal shape:

```ts
type RestTransporterRequest = {
  url: string
  method: string
  query?: Record<string, any>
  body?: Record<string, any> | string
  headers?: Record<string, string | undefined>
}
```

URL construction:

```text
GET    <api>/<ref>?<query>
POST   <api>/<ref>
PATCH  <api>/<collectionRef>/<id>
DELETE <api>/<collectionRef>/<id>
POST   <api>/<ref>/~<action>
```

Query values are serialized with `URLSearchParams`.

- `null` and `undefined` query values are skipped.
- Array query values are encoded as repeated params, for example `tag:in=a&tag:in=b`.
- Action names are URI encoded.

## Methods

### `query({ ref, filters, headers })`

Runs a collection or document read through HTTP `GET`.

```ts
const result$ = transporter.query({
  ref: 'users',
  filters: {
    ':limit': 20,
    'role:in': ['admin', 'editor'],
    'createdAt:sort': 'desc'
  },
  headers: {
    Authorization: `Bearer ${token}`
  }
})

result$.subscribe(result => {
  if (result.error) return console.error(result.error)
  console.log(result.changes)
})
```

Parameters:

| Parameter | Meaning |
| --- | --- |
| `ref` | Collection ref such as `users`, or document ref such as `users/u1`. |
| `filters` | Optional `LivequeryFilters<T>` object. Paging filters include `:limit`, `:after`, `:before`, `:around`, and `:page`. |
| `headers` | Optional per-query headers. These are merged into the outgoing request. |

When `ws` is configured, `query()` waits briefly for the socket to connect so it can attach socket metadata headers. If the socket is not ready, the REST query still runs.

Realtime watching is skipped for cursor/around paging filters:

- `:after`
- `:before`
- `:around`

### `add(ref, data)`

Creates a document through HTTP `POST`.

```ts
const user = await transporter.add('users', {
  name: 'Ada',
  role: 'admin'
})
```

Private fields whose names start with `_` are not sent.

### `update(collectionRef, id, data)`

Updates a document through HTTP `PATCH`. As with `add()`, fields whose names start with `_` are stripped before the request is sent.

```ts
const user = await transporter.update('users', 'u1', {
  name: 'Ada Lovelace'
})
```

### `delete(collectionRef, id)`

Deletes a document through HTTP `DELETE`.

```ts
await transporter.delete('users', 'u1')
```

### `trigger({ ref, action, payload })`

Calls a custom backend action through `POST /<ref>/~<action>`.

```ts
await transporter.trigger({
  ref: 'users/u1',
  action: 'ban',
  payload: {
    reason: 'policy_violation'
  }
})
```

## Hooks

### Add Auth Headers

```ts
const transporter = new RestTransporter({
  api: 'https://api.example.com',
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

### Serve A Cached Response

Returning `response` from `onRequest` skips `fetch()` entirely. `onResponse` still runs.

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

### Log Responses

```ts
const transporter = new RestTransporter({
  api: 'https://api.example.com',
  onResponse: async (request, response) => {
    console.info('livequery request', {
      method: request.method,
      url: request.url,
      failed: Boolean(response.error)
    })
  }
})
```

## Backend Contract

The backend must return a `LivequeryResult<T>` envelope:

```ts
type LivequeryResult<T> = {
  data: T
  error?: {
    code: string
    message: string
  }
}
```

Do not return raw arrays or raw documents. Wrap responses in `{ data }`.

### Collection Reads

For collection refs, return `data.items`:

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

`query()` converts each item to an `added` change for `@livequery/client`.

### Document Reads

For document refs, return `data.item`:

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

### Create Responses

`add()` accepts either a direct document:

```json
{
  "data": {
    "id": "u1",
    "name": "Ada"
  }
}
```

or a named wrapper such as `item`:

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

## Realtime WebSocket

When `ws` is configured, `RestTransporter` creates a `Socket` and attaches these metadata headers to REST calls:

- `socket_id`
- `x-lcid`
- `x-lgid`, when the gateway id has been received from `hello`

This lets the backend bind an HTTP query to the active realtime socket.

### Realtime Flow

1. The socket opens and sends `start`.
2. The server replies with `hello`.
3. A collection HTTP query returns `subscription_token`.
4. The transporter sends `subscribe` through the socket.
5. The server pushes `sync` messages.
6. `Socket.listen(ref)` emits `DataChangeEvent`s.

### WebSocket Messages

When the socket opens, the client sends:

```json
{ "event": "start", "data": { "id": "<client_id>" } }
```

Every 60 seconds after open, the client sends:

```json
{ "event": "ping" }
```

To subscribe:

```json
{ "event": "subscribe", "data": { "realtime_token": "<token>" } }
```

The server should reply with:

```json
{ "event": "hello", "gid": "gateway-1" }
```

If the server wants the client to send future socket messages as MessagePack binary payloads, set `binary: true`:

```json
{ "event": "hello", "gid": "gateway-1", "binary": true }
```

The initial `start` message is always JSON because it is sent before `hello` is received. Messages sent after `hello.binary === true`, such as `ping`, `subscribe`, and `unsubscribe`, are encoded with MessagePack.

Incoming messages may be JSON strings or MessagePack binary payloads. The socket parses JSON strings first and decodes binary payloads with MessagePack.

Realtime sync messages should use this shape:

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

Each sync change is normalized to:

```ts
type DataChangeEvent = {
  collection_ref: string
  id: string
  type: 'added' | 'removed' | 'modified'
  data?: Record<string, any>
}
```

## Direct `Socket` Usage

Most applications should use `RestTransporter` rather than `Socket` directly. `Socket` is exported for low-level integrations and debugging.

```ts
import { Socket } from '@livequery/rest'

const socket = new Socket('wss://api.example.com/ws')

const sub = socket.listen('users').subscribe(change => {
  console.log(change)
})

socket.subscribeWith('rt_abc123')

sub.unsubscribe()
socket.stop()
```

## Error Handling

If `fetch()` throws, the backend returns an error envelope, the backend returns invalid JSON, or the HTTP status is non-2xx, the transporter surfaces a structured error.

For `query()`, errors are emitted as observable results:

```ts
{
  source: 'query',
  error: {
    code: 'HTTP_500',
    message: 'Internal Server Error'
  }
}
```

For `add()`, `update()`, `delete()`, and `trigger()`, errors are thrown as rejected promises.

Invalid JSON becomes:

```ts
{
  code: 'InvalidResponse',
  message: 'The server did not return valid JSON.'
}
```

### Collection and document response errors

When the server returns a valid response envelope but the payload is missing expected fields, the transporter emits a structured error through the query observable:

**Missing `items` field on a collection query:**

```ts
{
  source: 'query',
  error: {
    code: 'INVALID_RESPONSE',
    message: "Server response is missing the 'items' field for collection query"
  }
}
```

**Missing `item` field on a document query:**

```ts
{
  source: 'query',
  error: {
    code: 'DOCUMENT_NOT_FOUND',
    message: "Document not found: server response is missing the 'item' field"
  }
}
```

These errors surface in `LivequeryCollection.error` and are available in React via `useObservable(collection.error)` or the third element of `useDocument()`.

### Complete error code reference

| Code | Source | Meaning |
|---|---|---|
| `HTTP_<status>` | `query()` | Non-2xx HTTP response, e.g. `HTTP_404`, `HTTP_500` |
| `InvalidResponse` | `query()`, `add()`, `update()`, `delete()` | Response body is not valid JSON |
| `INVALID_RESPONSE` | `query()` | Collection query succeeded but response has no `items` field |
| `DOCUMENT_NOT_FOUND` | `query()` | Document query succeeded but response has no `item` field |
| Backend-defined | Any | Your backend returned `{ error: { code, message } }` |

## Practical Example

```ts
import { LivequeryClient } from '@livequery/client'
import { RestTransporter } from '@livequery/rest'

export const livequery = new LivequeryClient({
  storage,
  transporters: {
    rest: new RestTransporter({
      api: import.meta.env.VITE_API_URL,
      ws: import.meta.env.VITE_WS_URL,
      onRequest: async ({ headers }) => ({
        headers: {
          ...headers,
          Authorization: `Bearer ${await auth.getToken()}`
        }
      }),
      onResponse: (_request, response) => {
        if (response.error?.code === 'Unauthorized') {
          auth.logout()
        }
      }
    })
  }
})
```

Application code should create collections from the shared `LivequeryClient`. Do not create a new transporter per component render.

## Development

Run tests:

```bash
bun run test
```

Build:

```bash
bun run build
```

Build steps:

- clean `dist/`
- emit Node.js ESM files with TypeScript
- generate `.js`, `.d.ts`, `.js.map`, and `.d.ts.map`

The package exposes these entrypoints:

- `@livequery/rest`
- `@livequery/rest/RestTransporter`
- `@livequery/rest/Socket`
- `@livequery/rest/helpers/parseJson`

## AI Agent Guidance

Repository-specific agent guidance lives in `AGENTS.md`. That file is for coding agents modifying this repository. This README is for package users.

## License

ISC
