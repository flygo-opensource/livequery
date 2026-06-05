# AGENTS.md

This document is for AI agents and developers working in the `@livequery/core` repository.

## Project Purpose

`@livequery/core` is the framework-agnostic runtime package for Livequery.

It provides:

- Shared request/response/context types.
- A handler interface for parser, middleware, datasource, auth, and realtime layers.
- Request parsing into normalized Livequery refs.
- UDP-based service and gateway discovery.
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

The public entrypoint is `src/index.ts`.

It exports:

- `const.ts`
- `UdpDiscovery.ts`
- `WebsocketGateway.ts`
- `ApiGatewayHandler.ts`
- `ApiServiceLinker.ts`
- `LivequeryContext.ts`
- `LivequeryDatasource.ts`
- `LivequeryRequestParser.ts`
- `helpers/hidePrivateFields.ts`

## Architecture

```mermaid
flowchart LR
  Client["Client HTTP/WebSocket"]
  Gateway["ApiGatewayHandler + WebsocketGateway"]
  Discovery["UdpDiscovery"]
  ServiceLinker["ApiServiceLinker"]
  Service["Service HTTP API"]
  Parser["LivequeryRequestParser"]
  Datasource["LivequeryDatasource / custom handler"]

  ServiceLinker --> Discovery
  Gateway --> Discovery
  Client --> Gateway
  Gateway --> Service
  Service --> Parser
  Parser --> Datasource
  Service --> Gateway
  Gateway --> Client
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
- Removes the route prefix before the data ref, such as `livequery`.
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
- Paths without the Livequery prefix.
- Empty path.

### `src/LivequeryDatasource.ts`

Type abstraction for datasource adapters.

A datasource must:

- Implement `handle(ctx)`.
- Implement `init(routes)`.

This file defines types only. It does not export a runtime class.

### `src/ApiGatewayHandler.ts`

HTTP gateway and reverse proxy.

Public methods:

- `register({ node_id, hostname, port, paths })`
- `deregister(node_id)`
- `fetch(request: Request): Promise<Response>`
- `fetch(req, res, extraHeaders?): Promise<void>`
- `fetchRequest(request)`
- `close()`

Behavior to preserve:

- Discovery only accepts metadata with `role === 'service'`.
- Metadata must match `API_GATEWAY_NAMESPACE`.
- Stale metadata is ignored when its version is older or equal.
- Newer metadata with the same service definition updates metadata and host only.
- Newer metadata with a changed service definition removes old routes and joins again.
- Route matching supports static segments, wildcard `:`, and prefix-param segments such as `post:`.
- Route hosts are selected by round-robin.
- Forwarded headers remove `content-length` and `host`.
- When `ws` exists in options, realtime forwarding headers are set from `x-lcid`, `socket_id`, and `x-lgid`.

Error responses:

- `404 API_NOT_FOUND`
- `503 API_OFFLINE`
- `502 SERVICE_API_OFFLINE`

### `src/ApiServiceLinker.ts`

Service-side metadata publisher.

Public methods:

- `start(name, port)`
- `close()`

Behavior:

- Publishes metadata with `role: 'service'`.
- Includes configured `paths`.
- Includes websocket metadata when options include `ws`.
- When it sees a gateway in the same namespace, it bumps metadata version and broadcasts again.

### `src/UdpDiscovery.ts`

Observable UDP discovery layer.

Public API:

- Constructor: `new UdpDiscovery<T>({ key, port? })`
- `status$`
- `broadcast(node, targetIp?)`
- `close()`

Behavior:

- Packets are msgpack encoded.
- Packets are signed with HMAC SHA-256.
- Packets older than 30 seconds are rejected.
- Packets with invalid signatures are rejected.
- Duplicate valid packets are emitted. Consumers handle dedupe.
- Nodes from all namespaces are emitted. Consumers handle namespace filtering.
- `close()` is idempotent.

UDP tests should use random ports to avoid conflicts.

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
- Close `UdpDiscovery`, `ApiGatewayHandler`, `ApiServiceLinker`, and `WebsocketGateway` instances in tests to avoid socket leaks.
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
