# Changelog — @livequery/honojs

## Unreleased

Nothing yet.

## 3.0.0

### Breaking
- Removed the discovery-driven gateway and service linker: `HonoApiGateway`,
  `HonoApiGatewayLinker` (`handler()`, `fetch()`, `gateway.register()`), `HonoApiServiceLinker`
  and their option types `HonoApiGatewayOptions` / `HonoApiServiceLinkerOptions`. A gateway is
  now `gateway({ routing })` over a declared `ServiceRouting` tree. A service needs no linker; it
  ends its chain with `realtime()`. (cf0d9d5)
- Removed these re-exports from `@livequery/core`: `UdpDiscovery` (and its `UdpDiscovery*`
  types), `ApiGatewayHandler`, `ApiServiceLinker` and `WEBSOCKET_PATH`. `WebsocketGateway` is no
  longer exported from the root. Import it from `@livequery/honojs/node` (`ws`) or
  `@livequery/honojs/bun` (`Bun.serve`), or use `realtimeGateway()`. (60ce1ea)
- The honojs datasource contract `LivequeryDatasource<RouteOptions>` (a `Subject` with `init` and
  `query`) was renamed `MappedDatasource<RouteOptions>`, and it no longer has to be a `Subject`.
  The name `LivequeryDatasource` now re-exports core's engine contract (`init` + `handle`).
- `ws` is now an optional peer dependency (`^8.18.0`; it was required, `>=8`). It is needed only
  for `/node` and `realtimeGateway()` on Node.

### Added
- Middleware chain for a route:
  `app.get(path, validator(Schema), livequery(), <datasource>(), realtime())`. (20d5716)
- `validator(schema, { patch? })`: validates the body against any Standard Schema (zod, valibot,
  arktype) and publishes the schema as the route's column allowlist. PATCH uses `patch` or
  `schema.partial()`. Otherwise it is left unvalidated, with a warning. `fieldsOf(schema)`,
  `LivequerySchema`, `ValidatorOptions`.
- `validator()`: on POST, a client-chosen `id` (uuidv7) is kept out of the schema check, so a
  `strictObject` need not declare it, and is handed to the datasource. (61e3aed)
- `realtime(target?)` middleware: after a read it subscribes the caller and after a write it
  publishes. With no target it only sets `x-livequery-ref` / `x-livequery-change` for a gateway.
  With an in-process gateway it calls `listen` / `next`. With `{ register, publish }` it hands the
  work to a Durable Object publisher. `LivequeryRealtimeTarget`, `LivequeryRealtimeSubscriber`,
  `LivequeryRealtimeSink`.
- `gateway({ routing, realtime?, principal? })`: proxies to the service that owns the path
  prefix, through a Worker service binding or a `url`. It acts on the realtime response headers
  and then strips them. A path no service owns falls through to `next()`. (31e32f3)
- `errorHandler()` for `app.onError()`: maps datasource `{ status, code, message }` throws to
  `{ error: { code, message } }`. A 5xx is logged and answered with a generic `INTERNAL`.
- `serve(app, { port, realtime })` and `realtimeGateway()`, chosen through the `workerd` / `bun` /
  `node` export conditions of the root entry. On Node, `serve()` starts `http.createServer` and
  attaches the gateway. On Bun it returns the `{ port, fetch, websocket }` object. On Workers it
  returns the app. (d827536)
- New entry points `@livequery/honojs/node` and `@livequery/honojs/bun`.
- `livequery({ realtime })` and `createDatasourceMapper({ realtime })`. The option was called
  `websocketGateway`, which is kept as a deprecated alias. `realtime` also accepts an async
  function `(subscription, c) => …`.
- `LivequeryRouter`, `createLivequery`, `livequery()` and `realtime()` are generic over Hono's
  `Env`, so `c.env` / `c.var` keep their types.
- Re-exports `LIVEQUERY_REF_HEADER` and `LIVEQUERY_CHANGE_HEADER`.

### Changed
- The root entry is runtime-neutral. It no longer pulls `http`, `node:dgram` or `node:os` into a
  Workers bundle.
- `livequery()` subscribes only after the handler succeeded with a 2xx. A failed read (403, 404,
  validation) used to subscribe the caller anyway.
- `livequery()` defaults its route pattern to Hono's `c.req.routePath`, so document routes no
  longer need `routePath`. It reads the validated body when `validator()` ran, so schema defaults
  and transforms survive.
- Depends on `@livequery/core` `^3.0.0`.

Migrating from 2.x: see [MIGRATION.md](../../MIGRATION.md).

## 2.x

Released from the pre-monorepo repositories; no changelog was kept.
