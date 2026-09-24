# Nâng từ Livequery 2.x lên 3.x

Chi tiết từng package nằm trong `packages/<name>/CHANGELOG.md`. Tài liệu này là danh sách việc phải
làm, theo thứ tự hay gặp khi nâng một ứng dụng thật. Mục nào ghi **(chưa phát hành)** là thay đổi
đã có trên `main` nhưng chưa lên npm; bản 3.0.0 trên npm vẫn hành xử như mô tả trong ngoặc.

## Danh sách kiểm tra

1. Gateway: bỏ `ApiGatewayHandler` / `ApiServiceLinker` / `UdpDiscovery`, chuyển sang
   `gateway({ routing })` hoặc tự proxy bằng `matchService()`.
2. Import `WebsocketGateway` từ `@livequery/core/node` (hoặc `/bun`), cài `ws`.
3. CORS của gateway cho qua `LIVEQUERY_CORS_HEADERS` — có `if-match` mới.
4. MongoDB: quyết định route nào nhận id do client chọn (`clientIds`, `sync`).
5. Collection `mode: 'local-first'`: đọc mục 5 — tên giữ nguyên nhưng ngữ nghĩa đổi.
6. Không truyền lại các field `_…` của client vào `update()` nếu còn dùng 3.0.0.
7. Peer dependency mới: `@livequery/core@^3` (datasource, adapter), `@livequery/client@^3`
   (`rest`, `react`), `rxjs`.

## 1. Gateway: không còn discovery và proxy trong process

Đã xoá khỏi `@livequery/core` ở mọi entry point: `ApiGatewayHandler` (`register()`,
`deregister()`, `fetch()`), `ApiServiceLinker`, `UdpDiscovery`, `ServiceApiMetadata` và các type
đi kèm, cùng các hằng `API_GATEWAY_*`, `LIVEQUERY_MAGIC_KEY`, `LIVEQUERY_GATEWAY_TIMEOUT_MS`.
Tương tự ở `@livequery/honojs` (`HonoApiGatewayLinker`, `HonoApiGateway`, `HonoApiServiceLinker`)
và `@livequery/nestjs` (`ApiGateway`, `ApiGatewayLinker`, `ApiServiceLinker`). Lý do: DESIGN.md mục 8.

**2.x**

```ts
import { ApiGatewayHandler, WebsocketGateway, UdpDiscovery } from '@livequery/core'

const ws = new WebsocketGateway(server)
const gateway = new ApiGatewayHandler({ ws, discovery: new UdpDiscovery({ key }) })
gateway.register({ node_id: 'tasks-1', hostname: '127.0.0.1', port: 8081,
    paths: [{ method: 'GET', path: 'livequery/tasks' }, { method: 'GET', path: 'livequery/tasks/:id' }] })
const response = await gateway.fetch(request)

// service
new ApiServiceLinker({ paths, ws, discovery }).start('tasks', 8081)
```

**3.x — cách A: `gateway({ routing })` của `@livequery/honojs`** (xem `examples/api-gateway`)

```ts
import type { ServiceRouting } from '@livequery/core'
import { gateway, realtimeGateway, serve } from '@livequery/honojs'

// Service sở hữu mọi path dưới tiền tố của nó; không liệt kê từng route.
const routing: ServiceRouting = {
    services: { tasks: { url: 'http://127.0.0.1:8081' } },      // Workers: { binding: 'TASKS' }
    routes: { livequery: { tasks: { $service: 'tasks' } } },
}
const realtime = await realtimeGateway()
const app = new Hono()
app.use('*', gateway({ routing, realtime }))
export default serve(app, { port: 8080, realtime })

// service: bỏ ApiServiceLinker; mỗi route kết thúc bằng realtime()
app.get('/livequery/tasks', validator(Task), livequery(), source, realtime())
```

**3.x — cách B: tự proxy** (khi không dùng Hono, hoặc cần giữ hành vi riêng)

```ts
import { matchService, LIVEQUERY_REF_HEADER, LIVEQUERY_CHANGE_HEADER } from '@livequery/core'

const url = new URL(request.url)
const matched = matchService(routing, url.pathname)          // $service sâu nhất thắng
if (!matched) return Response.json({ error: { code: 'NOT_FOUND', message: 'No service' } }, { status: 404 })
const response = await fetch(new Request(new URL(url.pathname + url.search, matched.target.url), request))
// Service báo việc qua header: x-livequery-ref → subscribe client vào ref đó,
// x-livequery-change: "<type> <ref>" → publish. Xử lý xong thì xoá hai header này.
```

Khác 2.x cần biết:

- Gateway không biết route cụ thể, nên 404/405 do service trả. 2.x trả 404/502/504 từ gateway;
  muốn giữ định dạng đó thì dùng cách B.
- Thêm route con chỉ cần deploy service; thêm service mới thì gateway phải có entry trong `routing`.
- Client **không tự gửi `subscribe`** được nữa (gateway bỏ qua); subscription chỉ tạo sau một lần
  đọc đã phân quyền. Mạng tin cậy muốn hành vi cũ: `new WebsocketGateway(server, { allowClientSubscribe: true })`.

## 2. `WebsocketGateway` và entry point theo runtime

```ts
// 2.x
import { WebsocketGateway } from '@livequery/core'

// 3.x
import { WebsocketGateway } from '@livequery/core/node'      // cần: bun add ws
import { WebsocketGateway } from '@livequery/core/bun'       // BunWebsocketGateway, cùng tên
import { HibernatableWebsocketGateway } from '@livequery/core/workers'
```

Root `@livequery/core` giờ không kéo Node built-in hay `ws`. `ws` là optional peer dependency.
Ở `@livequery/honojs`, `WebsocketGateway` nằm ở `@livequery/honojs/node` / `/bun`, hoặc gọi
`realtimeGateway()` để lấy bản của runtime đang chạy. Type `LivequeryDatasource` của honojs 2.x
đổi tên thành `MappedDatasource`.

## 3. CORS: header client gửi

`@livequery/rest` tự gắn `socket_id`, `x-lcid`, `x-lgid` (như 2.x) và **mới** `if-match` vào
mỗi bản sửa local-first. Gateway khác origin thiếu một header là trình duyệt chặn preflight, `fetch`
lỗi như mất mạng, và outbox thử lại mãi — server không thấy request nào.

```ts
import { LIVEQUERY_CORS_HEADERS } from '@livequery/core'   // (chưa phát hành) — 3.0.0: tự liệt kê 4 header

app.use('*', cors({ origin, allowHeaders: ['Content-Type', 'Authorization', ...LIVEQUERY_CORS_HEADERS] }))
```

Client chạy trong SharedWorker thì request không hiện trong devtools của trang hay trace của
Playwright; xem "Debugging A Client In A Worker" trong `packages/rest/README.md` (option `debug`,
chưa phát hành).

## 4. Id do client chọn

Client 3.x chọn id cho document mới (uuidv7, không còn `local:…`) và gửi trong body POST, để một
lần add thử lại sau khi mất response không tạo bản thứ hai. Id đó là id cuối cùng; code cũ kiểm
tra `id.startsWith('local:')` đổi thành `!!doc._adding`.

Phía server:

| Datasource | Mặc định | Ghi chú |
| --- | --- | --- |
| `@livequery/mongodb` (chưa phát hành) | chỉ nhận khi route có `sync: true` | route khác bỏ qua id, MongoDB cấp ObjectId, client đổi tên bản của nó |
| `@livequery/mongodb` 3.0.0 | nhận trên **mọi** route | lưu thành `_id` BSON UUID — xem cảnh báo dưới |
| `@livequery/postgres` 3.0.0 | nhận | khoá `serial`/`bigint` trả 400 `INVALID_ID`: đặt `clientIds: false` |
| `@livequery/d1` | nhận | id vốn là uuid text |

> **MongoDB 3.0.0:** route nào không có schema lọc bỏ `id` sẽ nhận `_id` UUID lẫn vào collection
> ObjectId, và mọi `new ObjectId(id)` vỡ. Đặt `clientIds: false` trên route cũ, hoặc nâng lên bản
> có mặc định mới. Nếu server 3.0.0 đã chạy: `db.coll.find({ _id: { $type: 'binData' } })`.

Id trong body mà không phải uuidv7 (và không phải `local:`) giờ là 400 `INVALID_ID` trên route nhận
client id; 2.x lặng lẽ bỏ qua. Trùng id là 409 `ID_ALREADY_EXISTS`, client coi là "đã tạo".

## 5. `mode: 'local-first'` đổi ngữ nghĩa

- **2.x:** tải hết các trang của collection vào storage, lọc cục bộ.
- **3.x:** "sync scope" — `'local-first'` bằng `{ scope: 'full', keep: '10m', evict: '30d' }`. Ghi
  đi qua outbox: mất mạng, 5xx, 401, 408, 429 thì mutation resolve với `_queued: true` thay vì đặt
  `_adding_error`; `client.outbox.pending$` cho biết còn bao nhiêu.
- **Đọc lại khi mở lại / nối lại:** chỉ đọc **delta** (`updated_at:gte` + `:tombstones`) khi route
  trả `sync: true` — tức `mongodb({ sync: true })`. Route khác được đọc lại toàn bộ phần máy đang
  giữ, và document bị xoá trên server bị xoá khỏi máy (scope `full`).

  > **3.0.0** suy ra "đọc delta được" chỉ từ việc document có `updated_at` dạng số. Trên route không
  > bật sync (không có tombstone), document bị xoá trên server **nằm mãi** trong bản sao local.
  > Bản chưa phát hành bỏ cờ cũ, nên máy đã đồng bộ bằng 3.0.0 đọc lại một lần rồi tự đúng.

- **`If-Match`:** bản sửa local-first gửi `updated_at` đang giữ; route `sync` trả 409
  `VERSION_CONFLICT` nếu có người ghi trước, client đưa qua `conflictResolver` rồi gửi lại. Route
  không sync bỏ qua header này (nhưng CORS vẫn phải cho nó qua, mục 3).
- **`updated_at`, `deleted_at` là field dành riêng** ở mọi mode: thay đổi có `deleted_at` bị coi
  là xoá; thay đổi có `updated_at` cũ hơn bản đang giữ bị bỏ. App dùng `deleted_at` cho thùng rác
  phải đổi tên field.
- Collection lớn nên khai báo scope thay vì tải hết:
  `mode: { scope: 'window', size: 200, sort: { created_at: 'desc' } }`.
- Storage tự viết phải tự phân trang (`:limit`, `:after`, `:before`); kiểm bằng
  `defineStorageConformanceSuite` từ `@livequery/client/testing`.

Muốn delta thật sự đúng: bật `mongodb({ sync: true })` và mọi lần ghi ngoài route (script, cron,
migration) phải qua `withVersion` — xem mục "Đổi dữ liệu hoặc schema khi máy đã giữ bản sao" của
README gốc.

## 6. `update({ ...doc.value, x })` với 3.0.0 và 2.x

Truyền lại cả `doc.value` (ví dụ form `reset(doc.value)` rồi submit nguyên) mang theo các field
trạng thái của client — `_adding`, `_prev`, `_updating`… Ở 3.0.0 và 2.x chúng đè lên trạng thái
client vừa tính, và outbox **bỏ bản sửa mà không gửi**: giao diện hiện giá trị mới, server không
nhận PATCH nào. Bản chưa phát hành bỏ qua các field đó. Với 3.0.0, lọc trước khi gọi:

```ts
const fields = Object.fromEntries(Object.entries(values).filter(([key]) => !key.startsWith('_')))
await doc.update(fields)
```

## 7. Linh tinh

- `_prev` của bản sửa server-first giờ là giá trị **trước** khi sửa (2.x giữ giá trị mới).
- `MongodbRealtime`: document chuyển sang parent ref khác sinh `removed` ở ref cũ và `added` ở
  ref mới (2.x: `modified` ở cả hai).
- Postgres: trùng khoá chính là 409 `ID_ALREADY_EXISTS`, unique khác là 409 `DUPLICATE_KEY`, thay
  cho lỗi `23505` thô của `pg`.
- `@livequery/rpc`: không đổi API. `@livequery/react`: không đổi API; `useCollection` tự re-render,
  `useObservable` thành tuỳ chọn.
- `LivequeryStorge` (alias gõ sai của `LivequeryStorage`) vẫn còn; dùng tên đúng.
