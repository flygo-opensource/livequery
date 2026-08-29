# Kế hoạch E2E Test — Livequery Full Stack

Mục tiêu: chứng minh hệ thống livequery hoạt động xuyên suốt **frontend (client, rest, react, rpc) → backend (core, honojs, nestjs, mongodb)** với MongoDB thật, realtime hoạt động ở cả 2 chế độ:
- **Self-emit**: service tự `gateway.next(UpdatedData)` hoặc `gateway.link(ref, pipe)`
- **Mongo watch**: `MongodbRealtime.watch()` qua change stream

Loại trừ: `indexeddb`, `mongoose`, `sqlite`.

## Hạ tầng chung

- **Mongo**: `mongodb://127.0.0.1:27017/` (env `LIVEQUERY_E2E_MONGO_URL`), **db `livequery`** (env `LIVEQUERY_E2E_DB_NAME`), `authSource=admin`.
- Mỗi suite dùng **collection name unique** (`<suite>_<Date.now()>`), xoá sạch ở `afterAll`.
- `MongodbRealtime` khởi tạo `{ enablePreAndPostImages: false }` (không cần quyền collMod).
- Runner: `bun test tests/` từ repo root; import cross-package theo pattern hiện có (`../<pkg>/src/...`, deps qua `../nestjs/node_modules/...`).
- Cleanup bắt buộc để bun exit: `transporter.socket.stop()`, `gateway.close()`, `server.closeAllConnections()`, `client.destroy()`, unsubscribe realtime watcher.

### Phase 0 — Helpers (`tests/helpers/`)

| File | Nội dung |
|---|---|
| `mongo.ts` | `connectMongo()`, `uniqueCollection(prefix)`, `seedDocs()`, `cleanup()` |
| `servers.ts` | `buildNestMongoApp(opts)` / `buildHonoMongoApp(opts)` → `{ port, apiUrl, wsUrl, gateway, datasource, mongo, close() }` — dựng full app: HTTP server + WebsocketGateway + MongoDatasource + (tuỳ chọn) MongodbRealtime |
| `wait.ts` | `waitFor(predicate, timeout)`, `collectEvents(observable)` |
| `ws.ts` | raw WS client helper (start/hello/sync) — tái dùng từ `nestjs/tests/e2e/helpers.ts` |

Đồng thời: chuẩn hoá 2 test e2e hiện có sang db `livequery` (đang là `livequery-test`).

---

## Phase 1 — Backend HTTP contract (adapter × MongoDatasource)

### 1.1 `hono-mongodb-crud.e2e.test.ts` ⭐ (gap lớn nhất — hono chưa có e2e nào)
Stack: `fetch` thuần → Hono (`createLivequery` + middleware + `createDatasourceMapper` + `useDatasource`) → MongoDatasource → Mongo thật.

Test cases:
- GET collection: items + paging (`count`, `has`, `cursor`), private field `_secret` bị ẩn, `_id → id`
- GET document `/:id` → `item`
- POST tạo doc → trả `item` có `id`; verify tồn tại trong Mongo bằng driver
- PATCH `/:id` → `$set` đúng field; verify Mongo
- DELETE `/:id` → doc biến mất khỏi Mongo
- Filters: `field:gte`, `field:like`, `field:in`, `field:eq-oid`
- Cursor paging: `:limit` + `:after` (2 trang, không trùng item, `has.next` đúng)
- Offset paging: `:page`
- Summary: `::total=count()`
- Route không khai báo → 404 `ROUTE_OPTIONS_NOT_FOUND`

### 1.2 `nestjs-mongodb-crud.e2e.test.ts`
Cùng matrix 1.1 nhưng qua NestJS (`UseLivequeryInterceptor` + controller trả `datasource.handle(ctx)` — theo pattern test hiện có). Bổ sung cái 2 e2e cũ chưa có: POST/DELETE qua HTTP, filters, paging 2 chiều.

---

## Phase 2 — Realtime backend

### 2.1 `hono-mongodb-realtime.e2e.test.ts` ⭐
- Raw WS client `start` → `hello` (lấy `gateway_id`)
- GET với `x-lcid`/`x-lgid` → middleware đăng ký subscription (verify qua `gateway.listen` spy)
- GET kèm cursor (`:after`) → KHÔNG đăng ký subscription
- **Mongo watch**: update doc bằng driver (out-of-band) → `MongodbRealtime.watch()` → `gateway.next` → client nhận `sync` đúng `{ref, type:'modified', data}`
- Insert → `added`, delete → `removed`
- Mutation qua chính HTTP API (POST/PATCH) cũng phát sync (chứng minh write path + watch path khép kín)

### 2.2 `realtime-self-emit.e2e.test.ts` ⭐ (yêu cầu "tự emit")
Stack: NestJS hoặc server thuần + gateway (không cần watcher).
- Service handler gọi `gateway.next({ref, type, data})` sau khi xử lý → client đã subscribe nhận sync
- `gateway.link(ref, () => interval-pipe)` → client nhận stream sync định kỳ
- Subscription **document-level** (`tasks/abc`): emit ref con → chỉ client sub doc đó nhận
- `unsubscribe` → không nhận tiếp
- 2 client cùng ref → cả 2 nhận; 1 unsubscribe → chỉ còn 1

### 2.3 `realtime-nested-ref.e2e.test.ts`
- Route lồng `users/:userId/posts` (schema từ parser) + MongodbRealtime fan-out
- Insert post với `userId=u1` → sync về ref `users/u1/posts`
- Field array (`userIds`) → membership added/removed như unit test nhưng chạy với Mongo thật

---

## Phase 3 — Frontend client full-stack ⭐⭐ (gap quan trọng nhất)

### 3.1 `client-nestjs-fullstack.e2e.test.ts`
Stack: `LivequeryClient` + `LivequeryMemoryStorage` + `RestTransporter(api, ws)` → NestJS → MongoDatasource + MongodbRealtime → Mongo.
- `collection.initialize(ref)` → `items` BehaviorSubject chứa seed data từ server, `loading` chuyển đúng trạng thái
- **Realtime vào collection**: update Mongo out-of-band → `collection.items` tự cập nhật (modified), insert → thêm item (added), delete → mất item (removed)
- `collection.add(payload)` (server-first) → doc persist vào Mongo, item trong collection có `id` server
- `collection.update/delete` → Mongo thay đổi đúng
- **Echo realtime sau mutation**: client A mutate → chính nó không duplicate item (dedup theo id)
- `loadMore()` với cursor thật từ MongoQuery
- `collection.filters` + `query()` → server filter đúng
- `trigger` action (`~action`) nếu backend khai báo route action

### 3.2 `client-hono-fullstack.e2e.test.ts`
Cùng matrix 3.1 trên Hono backend (qua `useDatasource` handler) — chứng minh client không phụ thuộc adapter.

### 3.3 `multi-client-sync.e2e.test.ts` ⭐
- 2 `LivequeryClient` độc lập (2 Socket, 2 client_id) cùng subscribe 1 ref
- Client A `add` → client B thấy item mới qua realtime (không gọi lại query)
- Client A `update` → client B nhận modified với đúng changed fields
- Client B unsubscribe (destroy collection) → không nhận nữa, client A vẫn nhận

---

## Phase 4 — React + RPC trên stack thật

### 4.1 `react-fullstack.e2e.test.tsx`
Harness: `react-test-renderer` + `React.act` (theo pattern `react/tests/`), backend từ Phase 3.
- `<LivequeryClientProvider core={client}>` + `useCollection(ref)` → items render từ server thật
- Update Mongo out-of-band → hook state tự cập nhật (assert sau `act` + waitFor)
- `useDocument(ref/id)` → `[doc, loading, error]` đúng vòng đời
- `useAction` wrap `collection.add` → loading/data/error states
- Đổi `ref` của `useCollection` → re-initialize sạch (không leak subscription cũ)

### 4.2 `rpc-livequery-bridge.e2e.test.ts`
Mô phỏng kiến trúc SharedWorker: collection sống ở "worker", UI nhận qua RPC.
- `WorkerManager.exposeService('todos', { items$: collection.items, add: (...) => collection.add(...) })` qua `MemoryChannel` (hoặc `SharedWorkerChannel` với MessagePort thật như rpc test hiện có)
- `ServiceLinker.linkService('todos')` → proxy
- `useObservable(proxy.items$)` (react-test-renderer) → render items
- Update Mongo out-of-band → collection (worker side) nhận realtime → **stream qua RPC** → hook state cập nhật
- `await proxy.add({...})` → persist Mongo, items$ emit qua RPC
- Disconnect channel → cleanup không leak

---

## Phase 5 — Cross-cutting / hardening

### 5.1 `gateway-multinode.e2e.test.ts`
- 2 WebsocketGateway trên 2 HTTP server, `gatewayB.connect(urlA, auth)`
- Client WS nối gateway A, subscribe ref; MongodbRealtime đẩy vào gateway B → sync route xuyên gateway tới client ở A
- (Mở rộng từ unit `02-websocket-gateway.test.ts` lên mongo thật)

### 5.2 `reconnect-and-errors.e2e.test.ts` (stretch)
- Socket reconnect: kill WS server → restart → Socket tự nối lại (backoff), subscription đăng ký lại được
- Transporter lỗi HTTP (500/timeout) → `collection.error` set, `loading` clear
- Mutation thất bại (server-first) → `_adding_error`/`_updating_error` flags

---

## Thứ tự thực hiện & độ ưu tiên

| # | File | Ưu tiên | Phụ thuộc |
|---|---|---|---|
| 0 | helpers | P0 | — |
| 1 | hono-mongodb-crud | P0 | helpers |
| 2 | hono-mongodb-realtime | P0 | 1 |
| 3 | client-nestjs-fullstack | P0 | helpers |
| 4 | realtime-self-emit | P1 | helpers |
| 5 | multi-client-sync | P1 | 3 |
| 6 | client-hono-fullstack | P1 | 1,2 |
| 7 | nestjs-mongodb-crud | P1 | helpers |
| 8 | react-fullstack | P1 | 3 |
| 9 | rpc-livequery-bridge | P2 | 3 |
| 10 | realtime-nested-ref | P2 | 2 |
| 11 | gateway-multinode | P2 | 4 |
| 12 | reconnect-and-errors | P3 | 3 |

## Rủi ro đã biết / lưu ý kỹ thuật

1. **Change stream cần replica set** — mongo 192.168.2.4 đã chạy OK ở 2 e2e hiện có.
2. **Hono serve trong bun test**: dùng `http.createServer` + `@hono/node-server` hoặc `Bun.serve` + `BunWebsocketGateway`; gateway phải wrap đúng server để WS upgrade hoạt động. Pattern an toàn nhất: `http.createServer()` → `WebsocketGateway(server)` → mount hono qua fetch adapter (đã có helper `nodeRequestToWebRequest`/`writeWebResponse` trong core).
3. **RestTransporter chờ gateway_id tối đa 3s** — phải đợi socket `hello` trước khi assert subscription, hoặc chấp nhận latency đầu.
4. **Socket heartbeat 60s + reconnect timer** — luôn `stop()` trong afterAll kẻo treo process.
5. **`hidePrivateFields` chạy 2 tầng** (interceptor + response helper) — assert không double-strip `id`.
6. **react-test-renderer + react 19** — đã dùng sẵn trong `react/tests`, giữ nguyên harness, không cần DOM.
7. Root `bun test` quét cả packages → chạy e2e bằng `bun test tests/` hoặc từng file để tránh nhiễu reflect-metadata cross-package đã biết.
