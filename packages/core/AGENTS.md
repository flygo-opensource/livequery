# AGENTS.md

This document is for AI agents and developers working in the `@livequery/core` repository.

## Project Purpose

`@livequery/core` is the framework-agnostic runtime package for Livequery.

It provides:

- Shared request/response/context types.
- A handler interface for parser, middleware, datasource, auth, and realtime layers.
- Request parsing into normalized Livequery refs.
- Ohayo HTTP-based service and gateway discovery.
- HTTP gateway routing and forwarding.
- Service metadata publishing.
- WebSocket realtime subscription routing.
- Response sanitization helpers.

The package does not execute database queries and does not depend on one HTTP framework.

## Livequery Specification

Before implementing request parsing, handlers, datasources, custom actions, response bodies, or realtime emission behavior, read `LIVEQUERY_SPEC.md`.

That file is the canonical framework- and database-independent definition of:

- Livequery refs.
- Collection and document path grammar.
- Default HTTP-method actions.
- Custom actions using `~verb`, which must use `POST`.
- Standard response envelopes: success responses use `{ data: ... }`, errors use `{ error: { message, code } }`.
- Fake or non-database Livequery handlers.
- Realtime create/update/delete emission with `WebsocketGateway.next(...)`.

## Current Public API

Entry points, each in `src/`:

| Entry | File | Exports |
| --- | --- | --- |
| `@livequery/core` | `index.ts` | `const.ts`, `LivequeryContext.ts`, `LivequeryDatasource.ts`, `LivequeryQuery.ts`, `LivequeryRealtime.ts`, `LivequeryRequestParser.ts`, `LivequeryBaseEntity.ts`, `WebsocketGatewayBase.ts`, `RealtimeBroker.ts`, `gateway/` (prefix routing), `helpers/` |
| `@livequery/core/node` | `node.ts` | root + `WebsocketGateway.ts` (`ws`) + the http ↔ Fetch helpers |
| `@livequery/core/bun` | `bun.ts` | root + `BunWebsocketGateway.ts` |
| `@livequery/core/workers` | `workers.ts` | root + `cloudflare/` (hibernating gateway, router, publisher) + `EdgeWebsocketGateway.ts` |

The root must stay runtime-neutral: `tests/root-entrypoint.test.ts` walks its import graph and
fails on a Node built-in, `ws`, or a runtime entry.

## Architecture

```mermaid
flowchart LR
  Client["Client HTTP/WebSocket"]
  Gateway["Hono gateway() — prefix routing"]
  Realtime["WebsocketGateway / BunWebsocketGateway / Durable Object"]
  Service["Service: validator → livequery → datasource → realtime"]
  Parser["LivequeryRequestParser"]
  Datasource["LivequeryDatasource (d1, mongodb, postgres)"]

  Client --> Gateway
  Client --> Realtime
  Gateway --> Service
  Service --> Parser
  Parser --> Datasource
  Service -- "x-livequery-ref / x-livequery-change" --> Gateway
  Gateway --> Realtime
  Realtime --> Client
```

## Module Guide

### `src/LivequeryContext.ts`

Core type definitions:

- `CollectionResponse<T>`: collection response with `items`, `paging`, and `cursor`.
- `DocumentResponse<T>`: document response with `item`.
- `RawRequest`: framework-adapter request shape.
- `LivequeryRequest<I>`: normalized request produced by `LivequeryRequestParser`.
- `LivequeryContext<T>`: shared context passed through handler pipelines.
- `LivequeryHandler<O>`: interface with `handle(ctx)`.

When adding a pipeline component, prefer implementing `LivequeryHandler`.

### `src/LivequeryRequestParser.ts`

First handler in a typical request pipeline.

- Input: `ctx.request`.
- Output: `ctx.livequery`.
- Requires the first path segment to be `livequery` and parses the data ref from the next segment.
- Removes query strings before parsing path segments.
- Removes suffixes after `~` in the pathname while preserving `~` inside query values.
- Detects document requests when the route pattern ends with a param segment.
- Uppercases the request method.

Important test cases:

- Collection path.
- Document path.
- Nested collection and document paths.
- Query string and `~` suffix handling.
- Query strings that contain `~`.
- Missing document ids for document-shaped route patterns.
- Paths missing the required Livequery prefix.
- Empty path.

### `src/LivequeryDatasource.ts`

Type abstraction for datasource adapters.

A datasource must:

- Implement `handle(ctx)`.
- Implement `init(routes)`.

This file defines types only. It does not export a runtime class.

### `src/gateway/matchService.ts`

Prefix routing for a gateway: walks the `ServiceRouting` tree segment by segment, keeps the
deepest `$service`, and matches any segment against a `:name` key. A service owns everything under
its prefix, so adding a route inside a service needs no gateway change.

### `src/WebsocketGateway.ts`

Realtime gateway. Extends `Subject<UpdatedData>`.

Public API:

- Constructor: `new WebsocketGateway(http.Server | portNumber)`
- `id`
- `auth`
- `handle(ctx)`
- `listen(events)`
- `unsubscribe_client(socket, body)`
- `detach(clientId, refs)`
- `link(ref, handler)`
- `connect(url, auth, ondisconnect?)`
- `close()`

Behavior:

- Node mode uses the `ws` package at `WEBSOCKET_PATH`.
- Bun mode uses `Bun.serve`.
- Client start event: `{ event: 'start', data: { id, auth } }`.
- Gateway-to-gateway auth uses `this.auth`.
- Duplicate socket ids are closed.
- `next(updatedData)` broadcasts `sync` to subscribers of `ref` and `${ref}/${data.id}`.
- `handle(ctx)` reads `ctx.livequery.ref`, `x-lcid` or `socket_id`, and `x-lgid`.
- `detach(clientId, refs)` removes a client from one ref or multiple refs without requiring the socket object.
- `link(ref, handler)` creates an update stream only when the ref already has a subscription.

### Helpers

`src/helpers/hidePrivateFields.ts`

- `hidePrivateFieldsInItem(item)`: removes fields starting with `_`, and maps `_id` to `id` when `id` is missing.
- `hidePrivateFields(data)`: supports plain items, collection responses, and document responses.

`src/helpers/nodeRequestToWebRequest.ts`

- Converts Node.js `IncomingMessage` with optional `rawBody` into a Web `Request`.
- Uses the host header or `127.0.0.1`.
- Merges `extraHeaders`.
- Omits body for `GET` and `HEAD`.

`src/helpers/writeWebResponse.ts`

- Copies a Web `Response` into a Node.js `ServerResponse`.

## Repository Rules

- Source is TypeScript ESM.
- Source imports must use `.js` extensions.
- Do not import through `src/index.ts` from inside `src`; import direct modules to avoid circular dependencies.
- Public runtime APIs must be exported from `src/index.ts`.
- When changing public classes or functions, update tests, `README.md`, and this file.
- Tests use `bun:test`.
- Test type-checking uses `tests/tsconfig.json`.
- Close `WebsocketGateway` instances in tests to avoid socket leaks.
- UDP tests should use random ports.
- HTTP server tests should close servers and active connections.

## Commands

```sh
bun run build
bun test tests/
bunx tsc -p tests/tsconfig.json --noEmit
```

## Test Layout

- `tests/entrypoint.test.ts`: public exports.
- Request parser tests: `LivequeryRequestParser`.
- `tests/api-gateway.test.ts`: gateway routing, discovery metadata, forwarding, errors, and round-robin.
- `tests/api-service-linker.test.ts`: service metadata publishing and rebroadcast behavior.
- `tests/http-discovery.test.ts`: Ohayo HTTP discovery registration, auth, namespace/tags filtering, and TTL offline events.
- `tests/udp-discovery.test.ts`: UDP packet validation, signatures, TTL, status, and close behavior.
- `tests/websocket-gateway.test.ts`: WebSocket lifecycle, subscriptions, observable links, and gateway bridge behavior.
- `tests/hono-api-gateway.e2e.test.ts`: in-process Hono service/gateway integration.
- `tests/hono-api-gateway-process.e2e.test.ts`: multi-process Hono services, gateway discovery, restart, and round-robin.
- `tests/hidePrivateFields.test.ts`: response sanitization.
- `tests/http-helpers.test.ts`: Node/Web HTTP helper conversion.

## When To Edit Tests Or Source

- If the user asks to edit tests only, do not modify `src`.
- If a new test exposes a source bug and the user did not allow source edits, report the bug clearly.
- If the user asks for implementation work, update source and relevant tests together.

## Final Verification Checklist

1. Run `bun run build`.
2. Run `bun test tests/`.
3. Run `bunx tsc -p tests/tsconfig.json --noEmit` when tests or test types changed.
4. Report changed files and verification results.
