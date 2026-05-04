# AGENTS.md

This file is for AI coding agents working in `@livequery/rest`.

## Purpose

`@livequery/rest` is a transport-layer library for `@livequery/core`.

This repository is a library package, not an application. Agents should preserve reusable transport behavior and public API compatibility by default.

- `RestTransporter` adapts the `LivequeryTransporter` contract to HTTP and optional WebSocket realtime.
- `Socket` manages client ids, gateway handshake, subscriptions, and reconnect behavior.
- `parseJson` is a small helper for tolerant JSON parsing.

## Source Of Truth

- Edit `src/`, never `dist/`. `dist/` is generated output.
- Keep ESM-style relative imports with `.js` extensions in source files.
- Preserve the public exports from `src/index.ts` unless the task explicitly changes package API.
- Validation command: `bun run build`.

## Project Map

- `src/RestTransporter.ts`: HTTP request building, request hooks, response parsing, realtime query merge.
- `src/Socket.ts`: WebSocket lifecycle, subscription topics, reconnect loop, gateway/client metadata.
- `src/helpers/parseJson.ts`: safe JSON parsing helper.
- `src/index.ts`: barrel exports.

## How Agents Should Use The Library

When writing real consumer code with this package, prefer these patterns:

- Create one `RestTransporter` per backend boundary and reuse it in a shared `LivequeryCore` instance.
- Pass `api` for REST-only usage and add `ws` only when the backend supports realtime sync.
- Install the transporter into `LivequeryCore` through the `transporters` map, for example `{ rest: transporter }`.
- Use `onRequest` to inject auth headers, override requests, or short-circuit with cached responses.
- Use `onResponse` for logging, metrics, or centralized error inspection.
- Treat this package as transport-only. Local cache, optimistic state, query modes, and reactive collections belong to `@livequery/core`.

Preferred consumer shape:

1. Create `RestTransporter({ api, ws?, onRequest?, onResponse? })`.
2. Create `LivequeryCore({ storage, transporters: { rest: transporter } })`.
3. Create collections from that core in app code.

Avoid these common mistakes in generated code:

- Do not treat `@livequery/rest` as a collection state library.
- Do not instantiate a new transporter per component render.
- Do not assume realtime is available when `ws` is omitted.
- Do not assume the backend returns raw arrays or raw documents; this transporter expects the `LivequeryResult<T>` envelope.
- Do not model query responses as full snapshot replacement. The returned observable emits `changes` compatible with `@livequery/core`.

## Runtime Model

- `query()` performs an HTTP GET and can merge a WebSocket stream when realtime is enabled.
- `add()`, `update()`, `delete()`, and `trigger()` call the matching REST endpoints.
- `Socket` is created lazily only when `ws` is configured.
- The transporter attaches socket metadata headers when WebSocket support is active.

## Backend Contract

- The backend must respond with `LivequeryResult<T>` shaped like `{ data, error? }`.
- Collection reads should return `data.items` and related paging metadata.
- Document reads should return `data.item`.
- Realtime change events should contain enough data for `DataChangeEvent` semantics.

## Important Constraints

- `onRequest` may return a `response` to skip the network entirely.
- `onResponse` runs for both fake responses and network responses.
- Realtime watching is skipped when there is no socket or when paging filters contain `:after`, `:before`, or `:around`.
- Collection refs and document refs are passed through to `@livequery/core`; this package should not reinterpret their meaning.

## Known Sharp Edges

- `RestTransporter.#call()` currently builds URLs with string concatenation and `URLSearchParams`; changes here can affect every operation.
- `Socket` identifies topic events by `ref` and keeps per-topic listen counts; cleanup timing changes can affect unsubscribe behavior.
- `Socket` uses runtime checks for `WebSocket`; do not introduce server-only assumptions into browser code or browser-only assumptions into non-browser paths.
- Query results merge the initial HTTP response with optional realtime events. Small changes in `query()` can alter core sync semantics significantly.

## Validation

- Preferred build check: `bun run build`.
- There is no dedicated automated test suite in this package at the moment.
- If you change transport request or response behavior, re-check both `src/RestTransporter.ts` and `src/Socket.ts`.

## Documentation Boundary

- `README.md` is end-user documentation.
- `AGENTS.md` should stay focused on implementation guidance, usage rules for generated code, and editing safety for agents.