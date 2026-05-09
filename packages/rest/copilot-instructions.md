# Copilot Instructions

This workspace is a library package, not an application.

When generating code, reviewing changes, or answering questions in this repository:

- Treat `@livequery/rest` as a reusable transport adapter for `@livequery/client`.
- Edit `src/`, never `dist/`.
- Keep `.js` suffixes in TypeScript source imports.
- Preserve public exports from `src/index.ts` unless the task explicitly changes package API.
- Use Bun for local commands when possible. Preferred validation command: `bun run build`.
- Generate consumer examples around a shared `RestTransporter` installed into a shared `LivequeryClient` instance.
- Use `onRequest` for auth, request overrides, or mocked responses, and `onResponse` for logging or response inspection.
- Treat the backend contract as `LivequeryResult<T>` with `{ data, error? }`, not raw payloads.
- Treat `query()` as a source of incremental `changes`, optionally merged with realtime socket events.
- Do not generate code that assumes WebSocket realtime exists unless `ws` is configured.
- Do not move collection-state responsibilities into this package; that logic belongs to `@livequery/client`.

Current implementation sharp edges worth remembering:

- Realtime subscription is bypassed for `:after`, `:before`, and `:around` paging filters.
- `Socket` subscription lifecycle depends on per-topic listen counts and delayed unsubscribe cleanup.
- Changing URL construction, hook sequencing, or query merge behavior can affect every transporter operation.