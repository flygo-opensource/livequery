# Local-only mode in @livequery/client

`local-only` is the mode for client-side state that should stay fully local.

Use this mode when your data is temporary, draft-like, private to one browser session, or when your app must continue working without remote sync.

## What local-only does

When a collection is initialized with `mode: "local-only"`:

- `query()` resolves from local storage.
- Remote transporters are not used for read paths.
- `add()`, `update()`, and `delete()` can be kept local by passing `"local-only"` as the action mode.
- Local documents are created with ids like `local:<uuid>`.
- `update()` on a local-only document stays local.
- `delete()` on a local-only document deletes locally.

In practice, this gives you a reactive local database experience through the same `LivequeryCollection` API.

## Quick example

```ts
import { LivequeryClient, LivequeryCollection, LivequeryMemoryStorage, type Doc } from "@livequery/client"

type Note = Doc<{
  title: string
  done: boolean
}>

const client = new LivequeryClient({
  storage: new LivequeryMemoryStorage(),
  transporters: {
    // optional: may exist for other collections, but this collection stays local-only
  },
})

const notes = new LivequeryCollection<Note>(client, {
  mode: "local-only",
  filters: { "title:sort": "asc" },
})

notes.initialize("notes")

// query from local storage only
await notes.query({ ":limit": 20 })

// explicit local-only add
await notes.add({ title: "Draft note", done: false }, "local-only")

// You can also be explicit
await notes.add({ title: "Pinned draft", done: false }, "local-only")

// Arrays keep array return types
const drafts = await notes.add([
  { title: "A", done: false },
  { title: "B", done: false },
], "local-only")

const first = notes.items.value[0]
if (first) {
  // local update
  await first.update({ done: true }, "local-only")
  // local delete
  await first.del("local-only")
}
```

## Behavior details to remember

- `local-only` is collection-scoped via `LivequeryCollectionOptions.mode`.
- Collection mutation methods also accept an optional explicit `mode` override: `"server-first" | "local-first" | "local-only"`.
- In the current implementation, mutation methods default to `"server-first"` when no explicit mode is passed.
- You can still use transporter-backed collections elsewhere in the same `LivequeryClient`.
- Reactive streams (`items`, `loading`, `error`, `summary`, `paging`) still work the same way.
- `query()` still requires `initialize(ref)` first.
- If a document was created locally (`id` starts with `local:`), delete becomes local hard-delete.
- Collection mutations preserve input shape in TypeScript: a single payload returns a single result, and an array payload returns an array.

## When to choose local-only vs local-first

Choose `local-only` when remote sync must be skipped entirely for that collection.

Choose `local-first` when you want immediate local reads but still want remote refresh and streamed remote changes.
