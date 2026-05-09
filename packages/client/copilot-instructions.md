# Copilot Instructions

This workspace is a library package, not an application.

When generating code, reviewing changes, or answering questions in this repository:

- Treat `@livequery/client` as a reusable public API package. Prefer backward-compatible changes unless the task explicitly asks for a breaking change.
- Edit `src/`, never `dist/`. Build output is generated.
- Keep TypeScript source imports in ESM form with explicit `.js` suffixes.
- Preserve the public API shape exported from `src/index.ts` unless the task explicitly changes the package surface.
- Do not rename `LivequeryStorge`. The spelling is intentional and part of the public API.
- Prefer minimal changes to runtime behavior. If you adjust filters, queries, or optimistic mutation state, verify the matching runtime path in `LivequeryCore`, `LivequeryMemoryStorage`, and `helpers/filterDocs`.
- Do not introduce app-specific assumptions such as routing, UI state, framework glue, or server processes into the package source.
- Assume browser-first runtime semantics for collection initialization. `LivequeryCollection.initialize()` currently exits early when `window` is unavailable.
- Remember that `items`, `summary`, `metadata`, `loading`, `filters`, `paging`, and `error` are reactive `BehaviorSubject`s or subjects. Reading `.value` is only a snapshot.
- For usage examples, show consumers creating a `LivequeryCore` with a storage adapter and one or more transporters, then creating a `LivequeryCollection` and subscribing to reactive state.
- In generated app code, prefer one shared `LivequeryCore`, then create collections from it and call `initialize(ref)` before any query or mutation.
- When generating UI code, subscribe to collection subjects or bridge them into framework state. Do not present `.value` reads as sufficient for live rendering.
- Use collection refs for list queries and document refs for single-document access.
- Show `query()` for immediate fetches, `debounceQuery()` only when debounce is configured, and `loadMore()` or `loadPrev()` only when paging cursors exist.
- Treat transporter query results as incremental change events. Do not model the transporter contract as full snapshot replacement unless the caller converts it explicitly.
- Preserve optimistic fields in examples and integrations when UI state needs pending or error visibility.
- Use Bun for local commands when possible. Preferred validation command: `bun run build`.

Current implementation sharp edges worth remembering:

- `LivequeryCollection` declares `metadata` but does not initialize it in the constructor.
- In `local-first` mode, rebroadcast filter checks only convert matching `added` events; modified docs that stop matching are not currently removed.
- Local optimistic mutation metadata lives on `_adding`, `_updating`, `_deleting`, `_prev`, and related error fields. Do not strip or rename those fields casually.
