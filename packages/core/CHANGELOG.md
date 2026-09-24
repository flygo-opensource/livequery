# Changelog — @livequery/core

## Unreleased

### Added
- `LIVEQUERY_CORS_HEADERS` (`socket_id`, `x-lcid`, `x-lgid`, `if-match`): the request headers the
  browser client (`@livequery/rest`) sets. A gateway on another origin must allow them in CORS
  preflight, e.g. `cors({ allowHeaders: ['Content-Type', 'Authorization', ...LIVEQUERY_CORS_HEADERS] })`.

## 3.0.1

### Added
- `resolveClientId(body)`, `CLIENT_ID_MAX_FUTURE_MS`, `ID_ALREADY_EXISTS`: validate the uuidv7 id a
  client picks for a new document. No id or a legacy `local:` id: the server assigns one. A uuidv7
  at most 24h in the future: used. Anything else: 400 `INVALID_ID`. (61e3aed)
- `LivequeryRequest.if_version`: the version a write was based on (from `If-Match`). Datasources
  use it to answer 409 `VERSION_CONFLICT` instead of overwriting a newer write. (23f492f)

### Changed
- `WebsocketGatewayBase`: a second socket that starts with the same client id now takes over. It
  gets the old socket's subscriptions and the old socket is closed. Before, the new socket was
  refused until the old one timed out, e.g. a half-open TCP behind a proxy. A peer gateway (gateway
  `auth`) still keeps its id for one connection only. (9fe8c2a)

### Fixed
- `WebsocketGatewayBase`: changes sent while a client was disconnected but still inside
  `disconnectGraceMs` were lost. They are now kept per client (at most 1000, oldest dropped
  first) and sent once, in order, as a `sync` event right after the reconnecting socket's
  `hello`. (4e56527)
- Docs: `README.md` and `LIVEQUERY_SPEC.md` no longer describe runtime discovery or
  `ApiGatewayHandler`. The gateway section now describes prefix routing. (88aea5b)

## 3.0.0

### Breaking
- Removed the discovery-driven proxying gateway (cf0d9d5): `ApiGatewayHandler` (with
  `register()`, `deregister()`, `fetch()`, `fetchRequest()`, `restGateway`), `ApiServiceLinker`,
  `UdpDiscovery`, and the types `ServiceApiMetadata`, `ServiceApiStatus`, `RegisterOptions`,
  `ApiGatewayOptions`, `ApiServiceLinkerOptions`, `UdpDiscoveryNode`, `UdpDiscoveryOptions`,
  `UdpDiscoveryPacket`, `UdpDiscoveryStatus`. They are gone from every entry point, including
  `/bun` and `/workers`. Use a declared `ServiceRouting` tree with `matchService()`, or
  `gateway({ routing })` from `@livequery/honojs`.
- Removed constants: `API_GATEWAY_NAMESPACE`, `LIVEQUERY_MAGIC_KEY`, `API_GATEWAY_MULTICAST_PORT`,
  `API_GATEWAY_MULTICAST_ADDRESS`, `API_GATEWAY_WHITELIST_ADDRESS`, `LIVEQUERY_GATEWAY_TIMEOUT_MS`.
- `WebsocketGateway` (the `ws` server) is no longer exported from the root `@livequery/core`.
  Import it from `@livequery/core/node`. `@livequery/core/bun` exports `BunWebsocketGateway`,
  also aliased as `WebsocketGateway`. `@livequery/core/workers` exports `EdgeWebsocketGateway`
  and the Durable Object pieces. The root entry is now runtime-neutral: it loads no Node
  built-in and no `ws`. (b88f4b5)
- Dependencies: `ws` and `msgpackr` are no longer dependencies. `ws` is now an optional peer
  dependency, so apps that use `@livequery/core/node` must install `ws` themselves.
- `WebsocketGatewayBase` now ignores `subscribe` frames from plain clients. Before, any socket
  could subscribe to any ref without passing the read's authorization. Subscriptions are
  registered server-side after an authorized read (`handle(ctx)` / `listen()`). Peer gateways
  are still honoured. To get the old behaviour back, set
  `new WebsocketGateway(server, { allowClientSubscribe: true })`. A client `unsubscribe` can only
  remove that client's own refs. (fd0884d)
- `NODE_ID` is now a random hex string. Before, it was typed as a UUID template literal.

### Added
- Prefix routing for gateways: `ServiceRouting`, `ServiceRoutingNode`, `ServiceTarget`
  (`binding` or `url`), `MatchedService`, `matchService(routing, pathname)`. The deepest
  `$service` wins, `:name` matches any segment, and `$auth` is inherited. (31e32f3)
- Headers for realtime across a gateway: `LIVEQUERY_REF_HEADER` (`x-livequery-ref`, sent after a
  read) and `LIVEQUERY_CHANGE_HEADER` (`x-livequery-change: <type> <ref>`, sent after a write).
- `LIVEQUERY_VARS`: the Hono context variable names shared by the middlewares.
- Realtime protocol types and constants: `LIVEQUERY_REALTIME_PATH`, `LivequeryRealtimeEvent`
  and its members (`LivequeryStartEvent`, `LivequeryHelloEvent`, `LivequerySubscribeEvent`,
  `LivequeryUnsubscribeEvent`, `LivequerySyncEvent`). Also `RealtimeSubscription`, which moved
  here from `WebsocketGatewayBase` and is still re-exported.
- `RealtimeBroker` contracts: `LivequeryChangeEvent`, `RealtimeEventPublisher`,
  `RealtimeEventConsumer`.
- `LIVEQUERY_PING_FRAME` / `LIVEQUERY_PONG_FRAME`: the exact keep-alive frames. The Node and Bun
  gateways answer the ping byte for byte, the same way the Workers runtime does. (85d7a8c)
- `toLivequeryError(thrown)` / `LivequeryError`: turn plain `{ status, code, message }` throws
  into real `Error`s.
- `decodeMsgpack()` and `decodeRealtimeFrame()`: a msgpack decoder with no dependencies, for
  binary client frames.
- `WebsocketGatewayOptions`: new `id` (stable gateway id), `binary` (the `hello.binary` flag,
  default `true`) and `allowClientSubscribe` (default `false`). New protected
  `_scheduleDetach()` / `_cancelDetach()` hooks.
- `@livequery/core/workers`: `HibernatableWebsocketGateway` (Durable Object Hibernation API,
  with the grace window kept by an alarm), `CloudflareRealtimeRouter`,
  `CloudflareRealtimePublisher`, `LIVEQUERY_PRINCIPAL_HEADER` and related constants and types.
  (eda3141, 1f37acd)
- `BunWebsocketGateway` accepts an options object `{ port?, path?, ...WebsocketGatewayOptions }`,
  or a port number as before, and exposes `path`.
- `nodeRequestToWebRequest()` and `writeWebResponse()` are exported from `/node` and `/bun`.

### Fixed
- Binary (msgpack) client frames were not decoded, so every `unsubscribe` from a client in
  binary mode was silently dropped. (eda3141)
- `nodeRequestToWebRequest()` streams the body of an unbuffered `IncomingMessage`. Before, a
  Node gateway dropped every POST/PUT body it proxied. (b88f4b5)
- A request stream that was already consumed is no longer attached as a body. It made `fetch`
  reject a bodyless DELETE with a 500. (fd0884d)
- `const.ts` no longer reads `process` on runtimes that do not have it (Workers, browsers).

Migrating from 2.x: see [MIGRATION.md](../../MIGRATION.md).

## 2.x

Released from the pre-monorepo repositories; no changelog was kept.
