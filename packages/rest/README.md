# @livequery/rest

REST transporter for [livequery](https://github.com/livequery) — connects your livequery client to a REST API backend with optional real-time WebSocket support.

## Installation

```bash
npm install @livequery/rest
# or
bun add @livequery/rest
```

## Usage

### Basic REST

```ts
import { RestTransporter } from '@livequery/rest'

const transporter = new RestTransporter({
  api: 'https://api.example.com'
})
```

### With WebSocket (real-time updates)

```ts
const transporter = new RestTransporter({
  api: 'https://api.example.com',
  ws: 'wss://api.example.com/ws'
})
```

### Request / Response Hooks

Use `onRequest` to modify or intercept outgoing requests (e.g. inject auth headers), and `onResponse` to inspect responses.

```ts
const transporter = new RestTransporter({
  api: 'https://api.example.com',
  ws: 'wss://api.example.com/ws',

  onRequest: async ({ url, method, headers, ref }) => {
    const token = await getAccessToken()
    return {
      headers: { Authorization: `Bearer ${token}` }
    }
  },

  onResponse: async (request, response) => {
    if (response.error) console.error('API error', response.error)
  }
})
```

You can also short-circuit a request by returning a `response` from `onRequest` — useful for caching or mocking:

```ts
onRequest: ({ ref }) => {
  const cached = cache.get(ref)
  if (cached) return { response: { data: cached } }
}
```

## API

### `RestTransporter`

#### Constructor options (`RestTransporterConfig`)

| Option | Type | Description |
|---|---|---|
| `api` | `string` | Base URL of your REST API |
| `ws` | `string` (optional) | WebSocket endpoint for real-time updates |
| `onRequest` | function (optional) | Interceptor called before each request. Return partial request overrides or a fake response. |
| `onResponse` | function (optional) | Called after each response. |

#### Methods

These follow the `LivequeryTransporter` interface from `@livequery/core`:

| Method | Description |
|---|---|
| `query(ref, filters)` | Query a collection or document. Returns an Observable. |
| `add(ref, data)` | Create a new document (`POST`) |
| `update(ref, id, data)` | Update a document (`PATCH`) |
| `delete(ref, id)` | Delete a document (`DELETE`) |
| `trigger({ ref, action, payload })` | Trigger a custom action (`POST /ref/~action`) |

### `Socket`

Manages the WebSocket connection lifecycle automatically — reconnects on failure, sends heartbeat pings, and routes server-pushed `DataChangeEvent`s to the appropriate collection streams.

```ts
import { Socket } from '@livequery/rest'

const socket = new Socket('wss://api.example.com/ws')
socket.listen('users/123').subscribe(change => console.log(change))
socket.stop() // close connection
```

## Real-time Flow

1. On `query()`, a `subscription_token` returned by the server is forwarded to the socket.
2. The socket subscribes to the token and listens for `sync` events from the server.
3. Incoming changes are emitted as `DataChangeEvent`s with `source: "realtime"`.

## Build

```bash
bun run build
```

Outputs ESM + type declarations to `dist/`.

## License

ISC
