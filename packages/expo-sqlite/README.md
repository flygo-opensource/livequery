# @livequery/expo-sqlite

A persistent `LivequeryStorage` for React Native and Expo, built on
[expo-sqlite](https://docs.expo.dev/versions/latest/sdk/sqlite/). React Native has no IndexedDB, so
`LivequeryIndexedDBStorage` falls back to memory there and loses everything on an app restart.
`LivequerySQLiteStorage` keeps all of it on disk:

- documents
- pending writes (`_adding`, `_updating`, `_deleting`, `_prev`, `_queued`)
- the outbox
- the sync's bookkeeping

It passes the same storage conformance suite as the memory and IndexedDB storages.

## Install

```sh
npx expo install expo-sqlite
npm install @livequery/expo-sqlite @livequery/client
```

Peer dependencies: `expo-sqlite` 14 or later (the async API; SDK 57 ships 57.x) and
`@livequery/client` ^3.2.0. New ids are uuidv7, which needs `crypto.getRandomValues`. Hermes does
not have it, so install a polyfill such as `react-native-get-random-values` or expo-crypto's.

## Usage

```ts
import { LivequeryClient } from '@livequery/client'
import { LivequerySQLiteStorage } from '@livequery/expo-sqlite'

export const client = new LivequeryClient({
  storage: new LivequerySQLiteStorage({ name: 'vinali-field' }),
  transporters: { rest },
})
```

Collections that must be on the phone at all times go local-first with a long `keep`:

```tsx
const elevators = useCollection<Elevator>('orgs/o1/elevators', {
  mode: { scope: 'full', keep: 'always', evict: '90d' },
})
if (elevators.status.value !== 'ready') return <Spinner />
```

After a restart, the collection answers from SQLite at once. The sync then asks the server only
for what changed since (`updated_at` + tombstones on a `sync: true` route).

## Options

| Option | Default | |
| --- | --- | --- |
| `name` | `livequery` | Database file `<name>.db`. Two storages with the same name share their data. |
| `database` | opened from `name` | An open database to use instead: an expo-sqlite `SQLiteDatabase`, or anything with the same async methods (`SQLiteDatabaseLike`). |
| `cache` | `true` | Keep each collection in memory once it has been read. |

`close()` closes a database the storage opened itself; a database passed in stays open. The
next call opens it again.

## One client per app process

The storage assumes it is **the only writer of its database**. It runs its operations one at a
time, in call order, so one read-modify-write never interleaves with another. With `cache`, it
answers queries from memory and does not re-read SQLite. An app has one JS runtime and one
`LivequeryClient`, so this holds. It does not coordinate with anything else: another storage on
the same `name` in the same process, a background task writing through its own connection, or
another process. Give those a different `name`, or pass `cache: false` and accept that two writers
can still race.

## How it stores and queries

- One table, `livequery_docs (collection, id, doc)`, with the primary key `(collection, id)`.
  Each document is stored as JSON, so values must be plain JSON: a `Date` becomes a string, and
  `undefined` fields are dropped.
- The database uses WAL with `synchronous = NORMAL`. A write does not wait for fsync, so the
  initial sync of thousands of documents stays fast. An app crash loses nothing; a power cut can
  lose the last few writes, which the next sync fetches again.
- `query()` runs `queryDocs()` from `@livequery/client` over the collection, the same code as the
  memory storage. Filters, sort order (MongoDB's), `total`, and `:after` / `:before` cursors are
  identical to the other storages. With `cache` on, the first query of a collection reads it from
  SQLite once, and later queries run in memory. With 5,000 documents in Bun: about 4 ms for the
  first read, and 0.2 ms for a filtered, sorted page after that.
- A server id that replaces a `local:` id is written in one exclusive transaction (delete the old
  row, insert the new one). A failure leaves the document where it was.
- `flush()` empties the table (logout, account switch).

Memory cost is the documents of the collections the app has read, as parsed JSON: about what the
screens already hold. Pass `cache: false` to read from SQLite on every query instead.

## Testing

Pass a database. The package's own tests wrap `bun:sqlite` in the `SQLiteDatabaseLike` shape
(`tests/sqlite.ts`) and run the conformance suite against it:

```ts
import { defineStorageConformanceSuite } from '@livequery/client/testing'

defineStorageConformanceSuite({
  name: 'LivequerySQLiteStorage',
  create: () => new LivequerySQLiteStorage({ database: openTestDatabase() }),
  describe, test, expect,
})
```

`expo-sqlite` is imported only when the storage has to open a database itself. Tests that pass a
`database` never load the native module.
