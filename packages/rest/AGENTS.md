# AGENTS.md

This file is for AI coding agents working in `@livequery/rest`.

Use the plural filename `AGENTS.md`. It is the convention this repository uses for agent instructions.

## Purpose

`@livequery/rest` is a transport-layer library for `@livequery/client`.

This repository is a library package, not an application. Agents should preserve reusable transport behavior and public API compatibility by default.

- `RestTransporter` adapts the `LivequeryTransporter` contract to HTTP and optional WebSocket realtime.
- `Socket` manages client ids, gateway handshake, subscriptions, reconnect behavior, and JSON/MessagePack socket messages.
- `parseJson` is a small helper for tolerant JSON parsing.

## Source Of Truth

- Edit `src/`, never `dist/`. `dist/` is generated output.
- Keep ESM-style relative imports with `.js` extensions in source files.
- Preserve the public exports from `src/index.ts` unless the task explicitly changes package API.
- Validation commands: `bun run test` and `bun run build`.

## Project Map

- `src/RestTransporter.ts`: HTTP request building, request hooks, response parsing, realtime query merge.
- `src/Socket.ts`: WebSocket lifecycle, subscription topics, reconnect loop, gateway/client metadata, JSON/MessagePack parsing and sending.
- `src/helpers/parseJson.ts`: safe JSON parsing helper.
- `src/index.ts`: barrel exports.
- `tests/RestTransporter.test.ts`: request construction, headers, and error handling tests.
- `tests/Socket.test.ts`: fake WebSocket tests for JSON and MessagePack behavior.

## How Agents Should Use The Library

When writing real consumer code with this package, prefer these patterns:

- Create one `RestTransporter` per backend boundary and reuse it in a shared `LivequeryClient` instance.
- Pass `api` for REST-only usage and add `ws` only when the backend supports realtime sync.
- Install the transporter into `LivequeryClient` through the `transporters` map, for example `{ rest: transporter }`.
- Use `onRequest` to inject auth headers, override requests, or short-circuit with cached responses.
- Use `onResponse` for logging, metrics, or centralized error inspection.
- Treat this package as transport-only. Local cache, optimistic state, query modes, and reactive collections belong to `@livequery/client`.
- Use `headers` on `query()` for per-query request headers. Use `onRequest` for global or dynamic request handling.

Preferred consumer shape:

1. Create `RestTransporter({ api, ws?, onRequest?, onResponse? })`.
2. Create `LivequeryClient({ storage, transporters: { rest: transporter } })`.
3. Create collections from that core in app code.

Avoid these common mistakes in generated code:

- Do not treat `@livequery/rest` as a collection state library.
- Do not instantiate a new transporter per component render.
- Do not assume realtime is available when `ws` is omitted.
- Do not assume the backend returns raw arrays or raw documents; this transporter expects the `LivequeryResult<T>` envelope.
- Do not model query responses as full snapshot replacement. The returned observable emits `changes` compatible with `@livequery/client`.

## Runtime Model

- `query()` performs an HTTP GET and can merge a WebSocket stream when realtime is enabled.
- `add()`, `update()`, `delete()`, and `trigger()` call the matching REST endpoints.
- `Socket` is created lazily only when `ws` is configured.
- The transporter attaches socket metadata headers when WebSocket support is active.
- If `ws` is configured, `query()` waits briefly for socket readiness but must still work over REST when the socket is unavailable.
- Incoming socket messages can be JSON strings or MessagePack binary payloads.
- The server can send `{ event: "hello", gid, binary: true }` to request that future client socket messages are MessagePack encoded. The initial `start` message is still JSON because it is sent before `hello`.

## Backend Contract

- The backend must respond with `LivequeryResult<T>` shaped like `{ data, error? }`.
- Collection reads should return `data.items` and related paging metadata.
- Document reads should return `data.item`.
- Realtime change events should contain enough data for `DataChangeEvent` semantics.
- HTTP non-2xx responses and invalid JSON should surface as structured errors, not silent `undefined` data.

## Important Constraints

- `onRequest` may return a `response` to skip the network entirely.
- `onResponse` runs for both fake responses and network responses.
- Realtime watching is skipped when there is no socket or when paging filters contain `:after`, `:before`, or `:around`.
- Collection refs and document refs are passed through to `@livequery/client`; this package should not reinterpret their meaning.
- Do not assume query filters are simple strings. Array filter values are encoded as repeated query parameters.
- Do not send raw arrays or raw documents from example backends; examples must use the `LivequeryResult<T>` envelope.

## Known Sharp Edges

- `RestTransporter.#buildUrl()` affects every operation. Be careful with slash normalization, action encoding, array query params, and null/undefined query values.
- `RestTransporter.#call()` owns hook ordering, request headers, socket metadata headers, HTTP error handling, and invalid JSON handling.
- `Socket` identifies topic events by `ref` and keeps per-topic listen counts; cleanup timing changes can affect unsubscribe behavior.
- `Socket` uses runtime checks for `WebSocket`; do not introduce server-only assumptions into browser code or browser-only assumptions into non-browser paths.
- `Socket` sets `binaryType = "arraybuffer"` so MessagePack inbound payloads can be decoded predictably.
- `Socket` has one connection state source of truth: it extends `BehaviorSubject<LivequerySocketMetadata>`. Do not reintroduce a separate `$connected` state unless there is a deliberate compatibility reason.
- Query results merge the initial HTTP response with optional realtime events. Small changes in `query()` can alter core sync semantics significantly.

## Validation

- Preferred checks: `bun run test` and `bun run build`.
- The test suite uses Bun's built-in test runner.
- If you change transport request or response behavior, re-check both `src/RestTransporter.ts` and `src/Socket.ts`.
- If you change WebSocket JSON/MessagePack behavior, update `tests/Socket.test.ts`.
- If you change URL construction, headers, hooks, or response errors, update `tests/RestTransporter.test.ts`.

## Documentation Boundary

- `README.md` is end-user documentation. It should explain package purpose, usage, parameters, backend contract, realtime protocol, and practical examples.
- `AGENTS.md` should stay focused on implementation guidance, usage rules for generated code, and editing safety for agents.
- `copilot-instructions.md` is a short companion instruction file for Copilot-style tools. Keep it consistent when behavior changes materially.
