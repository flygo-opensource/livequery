# @livequery/new

Thư viện livequery cho mô hình local-first trên browser client.

Hiện tại package này tập trung vào:
- Core livequery.
- Collection reactive state.
- Storage in-memory (`LivequeryMemoryStorage`).

Các adapter persistent như localStorage/IndexedDB sẽ tách sang package khác.

## Cài đặt

~~~bash
npm i @livequery/new rxjs
~~~

Hoặc với bun:

~~~bash
bun add @livequery/new rxjs
~~~

## Export chính

Package export toàn bộ API từ:
- src/LivequeryCollection.ts
- src/LivequeryCore.ts
- src/LivequeryMemoryStorage.ts
- src/LivequeryStorge.ts
- src/LivequeryTransporter.ts
- src/types.ts
- src/helpers/WorkerRpc.ts

## Ví dụ nhanh

~~~ts
import { of } from "rxjs"
import {
  LivequeryCollection,
  LivequeryCore,
  LivequeryMemoryStorage,
  type LivequeryAction,
  type LivequeryDocument,
  type LivequeryFilters,
  type LivequeryQueryParams,
  type LivequeryQueryResult,
  type LivequeryTransporter,
} from "@livequery/new"

type Todo = LivequeryDocument & {
  title: string
  done: boolean
  createdAt: number
}

const storage = new LivequeryMemoryStorage()

const transporter: LivequeryTransporter = {
  query<T extends LivequeryDocument>(query: LivequeryQueryParams<T>) {
    const result: Partial<LivequeryQueryResult<T>> = {
      query_id: query.query_id,
      changes: [],
      summary: {},
      paging: { total: 0, current: 0 },
      metadata: {},
      source: "query",
    }
    return of(result)
  },
  trigger<T extends LivequeryDocument>(_action: LivequeryAction<T>) {
    return of({} as T)
  },
}

const core = new LivequeryCore({
  storage,
  transporters: { primary: transporter },
  resolver: ({ change, old_document }) => ({
    approved: true,
    document: { ...old_document, ...change.data } as Todo,
  }),
})

const filters: LivequeryFilters<Todo> = {
  "createdAt:sort": "desc",
  ":limit": 20,
  ":page": 1,
  ":before": "",
  ":after": "",
}

const todos = new LivequeryCollection<Todo>(core, {
  ref: "todos",
  filters,
  lazy: true,
})

todos.subscribe((state) => {
  console.log(state.items.map((doc$) => doc$.value))
})

await storage.add<Todo>("todos", {
  id: crypto.randomUUID(),
  "@syncing": {},
  title: "Ship memory storage",
  done: false,
  createdAt: Date.now(),
})

await todos.query({
  "done:boolean": "false",
  "createdAt:sort": "desc",
  ":limit": 20,
})
~~~

## LivequeryMemoryStorage

`LivequeryMemoryStorage` implement `LivequeryStorge` bằng `Map` trong RAM.

Có các method contract:
- `query(collection, filters)`
- `add(collection, document)`
- `update(collection, id, document)`
- `delete(collection, id)`

Method tiện ích thêm:
- `seed(collection, docs)` để nạp dữ liệu ban đầu.
- `clear(collection?)` để xoá một collection hoặc toàn bộ bộ nhớ.

Lưu ý:
- Dữ liệu sẽ mất khi reload trang/app.
- Phù hợp để phát triển local-first flow, test logic và demo nhanh.

## Build

~~~bash
bun run build
~~~

Build output đặt tại `dist`.

## Ghi chú

- Tên interface storage hiện tại theo source code là `LivequeryStorge`.
- Runtime target: browser ESM.
