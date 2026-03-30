# @livequery/new

Thư viện livequery cho mô hình local-first trên browser client.

Mục tiêu chính:
- Đọc dữ liệu nhanh từ local storage (offline-first UX).
- Đồng bộ truy vấn và hành động CRUD qua transporter realtime.
- Trả dữ liệu theo dạng Observable để UI cập nhật liên tục.

## Cài đặt

~~~bash
npm i @livequery/new rxjs
~~~

Hoặc dùng bun:

~~~bash
bun add @livequery/new rxjs
~~~

## Tư duy local-first trong thư viện

Luồng chuẩn khi gọi query:
1. Collection gọi core.query.
2. Core trả dữ liệu từ storage trước (local cache).
3. Core đồng thời đẩy request qua các transporter.
4. Kết quả query/realtime từ transporter được merge vào collection state.

Nhờ đó UI luôn có dữ liệu hiển thị sớm, sau đó tự cập nhật khi server/realtime trả về thay đổi.

## Export chính

Package export toàn bộ API từ:
- src/LivequeryCollection.ts
- src/LivequeryCore.ts
- src/LivequeryStorge.ts
- src/LivequeryTransporter.ts
- src/types.ts
- src/helpers/WorkerRpc.ts

## Ví dụ nhanh

~~~ts
import { Observable, of } from "rxjs"
import {
	LivequeryCollection,
	LivequeryCore,
	type LivequeryAction,
	type LivequeryDocument,
	type LivequeryFilters,
	type LivequeryQueryParams,
	type LivequeryQueryResult,
	type LivequeryStorge,
	type LivequeryTransporter,
} from "@livequery/new"

type Todo = LivequeryDocument & {
	title: string
	done: boolean
	createdAt: number
}

const memoryStore = new Map<string, Todo[]>()

const storage: LivequeryStorge = {
	async query<T extends LivequeryDocument>(collection: string) {
		return ((memoryStore.get(collection) || []) as unknown as T[])
	},
	async add<T extends LivequeryDocument>(collection: string, document: T) {
		const list = (memoryStore.get(collection) || []) as unknown as T[]
		list.push(document)
		memoryStore.set(collection, list as unknown as Todo[])
		return document
	},
	async update<T extends LivequeryDocument>(collection: string, id: string, patch: Partial<T>) {
		const list = (memoryStore.get(collection) || []) as unknown as T[]
		const idx = list.findIndex((x) => x.id === id)
		if (idx < 0) return null
		list[idx] = { ...list[idx], ...patch }
		memoryStore.set(collection, list as unknown as Todo[])
		return list[idx]
	},
	async delete<T extends LivequeryDocument>(collection: string, id: string) {
		const list = (memoryStore.get(collection) || []) as unknown as T[]
		const idx = list.findIndex((x) => x.id === id)
		if (idx < 0) return null
		const [deleted] = list.splice(idx, 1)
		memoryStore.set(collection, list as unknown as Todo[])
		return deleted
	},
}

const transporter: LivequeryTransporter = {
	query<T extends LivequeryDocument>(_query: LivequeryQueryParams<T>) {
		const result: Partial<LivequeryQueryResult<T>> = {
			query_id: _query.query_id,
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

const initialFilters: LivequeryFilters<Todo> = {
	"createdAt:sort": "desc",
	":limit": 20,
	":page": 1,
	":before": "",
	":after": "",
}

const todos = new LivequeryCollection<Todo>(core, {
	ref: "todos",
	filters: initialFilters,
	lazy: true,
})

todos.subscribe((state) => {
	console.log("items", state.items.map((item$) => item$.value))
	console.log("loading", state.loading)
})

await todos.query({
	"done:boolean": "false",
	"createdAt:sort": "desc",
	":limit": 20,
})

todos.add({
	id: crypto.randomUUID(),
	"@syncing": {},
	title: "Ship README",
	done: false,
	createdAt: Date.now(),
})
~~~

## API chi tiết

### 1) LivequeryCore

Khởi tạo với config:
- storage: adapter local data store.
- transporters: danh sách transporter theo key.
- resolver: hàm resolve conflict (đang có trong type config).

Hàm chính:
- watch(ref, collection_id): Observable stream nhận event query/realtime.
- query(req): trả Promise dữ liệu từ storage và trigger query nền qua transporter.
- trigger(action): broadcast action qua tất cả transporter.

### 2) LivequeryCollection

Là BehaviorSubject chứa state của một collection.

State gồm:
- ref
- indexes: map id -> index
- items: mảng BehaviorSubject theo từng document
- summary, metadata
- loading: all, next, prev
- filters
- paging: next/prev/total/current

Method:
- query(filters)
- loadMore()
- loadPrev()
- loadAround(cursor)
- add(payload)
- update(id, payload)
- delete(id)
- trigger(action, payload)
- unsubscribe()

Lưu ý type hiện tại yêu cầu lazy là true khi khởi tạo collection.

### 3) LivequeryStorge

Storage adapter bắt buộc implement:
- query(collection, filters)
- add(collection, document)
- update(collection, id, document)
- delete(collection, id)

Gợi ý backend local-first:
- IndexedDB cho dữ liệu lớn.
- localStorage/sessionStorage cho dữ liệu nhỏ.
- Có thể kết hợp Dexie/LocalForage nếu muốn.

### 4) LivequeryTransporter

Transporter là lớp kết nối server/realtime.

Contract:
- query(queryParams): trả Observable của partial query result.
- trigger(action): trả Observable cho kết quả action.

Bạn có thể có nhiều transporter cùng lúc, ví dụ:
- HTTP pull ban đầu
- WebSocket hoặc SSE cho realtime

### 5) Type filter

Filter key được build từ field name + hậu tố, ví dụ:
- number: price:gt, price:lte, price:in
- string: title:like, title:in
- boolean: done:boolean
- sort: createdAt:sort
- paging: :limit, :before, :after, :page

## WorkerRpc helper

WorkerRpc giúp gọi service qua SharedWorker theo dạng RPC:
- exposeWorkerService(instance): expose class instance trong worker.
- linkWorkerService<T>(serviceName, worker): tạo proxy typed ở main thread.

Proxy trả ThenableObservable:
- Có thể await như Promise.
- Hoặc subscribe như Observable.

## Build và publish

Scripts hiện có:

~~~bash
bun run build
bun run build:watch
~~~

Build output:
- dist/index.js
- dist/index.d.ts
- Các file declaration theo module trong dist

Checklist publish npm:
1. Cập nhật version trong package.json.
2. Chạy bun run build.
3. Kiểm tra gói bằng npm pack.
4. Publish bằng npm publish.

## Ghi chú hiện trạng

- Tên type storage hiện tại là LivequeryStorge theo source code.
- Thư viện phụ thuộc rxjs.
- Mục tiêu runtime là browser ESM.
