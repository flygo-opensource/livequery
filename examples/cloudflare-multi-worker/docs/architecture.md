# Kiến trúc

## Mục tiêu

Example giải quyết ba yêu cầu:

1. Dùng chung code, types và route contract trong một monorepo.
2. Deploy Gateway, Tasks API và Incidents API thành ba Worker độc lập.
3. Giữ hai service API private và chỉ expose Gateway ra Internet.

## Thành phần

| Thành phần | Cloudflare name | Public | Storage | Trách nhiệm |
| --- | --- | --- | --- | --- |
| API Gateway | `livequery-api-gateway` | Có | Không | CORS, health check, match route và forward request |
| Tasks service | `livequery-tasks-service-api` | Không | `TASKS_DB` | CRUD và phân trang task |
| Incidents service | `livequery-incidents-service-api` | Không | `INCIDENTS_DB` | CRUD và phân trang sự cố |

Hai service đặt cả `workers_dev: false` và `preview_urls: false`. Gateway giữ endpoint public và sở hữu hai Service Bindings:

| Binding tại Gateway | Target Worker |
| --- | --- |
| `TASKS_SERVICE` | `livequery-tasks-service-api` |
| `INCIDENTS_SERVICE` | `livequery-incidents-service-api` |

## Luồng request

Ví dụ `PATCH /livequery/tasks/task-01`:

```text
1. Client gọi Gateway
2. Gateway tìm method + pathname trong GATEWAY_ROUTES
3. Route matcher chọn TASKS_SERVICE
4. Gateway gọi await env.TASKS_SERVICE.fetch(request)
5. Tasks service để Hono match /livequery/tasks/:id
6. shared/d1-service.ts tạo LivequeryContext
7. LivequeryRequestParser phân tích collection, document id và query
8. D1Datasource.init(routes) đăng ký table mapping
9. D1Datasource.handle(ctx) thực thi PATCH trên TASKS_DB
10. Response đi ngược qua Service Binding về client
```

Gateway dùng HTTP Service Binding thay vì RPC vì Livequery đã có HTTP route contract. Cách này giữ nguyên method, URL, headers và body của request.

## Static dispatch

`shared/routes.ts` là source of truth để Gateway chọn service. Matcher chỉ dùng method và pathname, không dùng hostname hoặc query string.

Một route có ba thuộc tính:

```ts
type GatewayRoute = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  binding: 'TASKS_SERVICE' | 'INCIDENTS_SERVICE'
}
```

Đây không phải Dynamic Dispatch Worker và không dùng Workers for Platforms. Khi thêm target Worker mới, Gateway phải có binding mới trong `wrangler.jsonc` và được deploy lại.

## LivequeryDatasource contract

`shared/d1-service.ts` không gọi trực tiếp các method riêng của `D1Datasource`. Mỗi request đi qua contract chuẩn:

```ts
const datasource = new D1Datasource({
  databases: { default: database },
})

await datasource.init(routes)
await datasource.handle(ctx)
```

`ctx.request.ref` là Hono route pattern, ví dụ `/livequery/tasks/:id`; `ctx.request.path` là pathname thực, ví dụ `/livequery/tasks/task-01`. `LivequeryRequestParser` dùng hai giá trị này để lấy `document_id` và route keys.

Datasource được tạo bên trong request handler vì D1 binding thuộc `env` của invocation. Không lưu request, binding hoặc context trong mutable global state.

## Data ownership

Mỗi service sở hữu database và migrations riêng:

```text
tasks-service-api-worker/migrations       -> TASKS_DB
incidents-service-api-worker/migrations   -> INCIDENTS_DB
```

Không service nào truy cập database của service còn lại. Nếu sau này cần dữ liệu chéo, nên định nghĩa API/RPC rõ ràng hoặc xây read model riêng, thay vì chia sẻ trực tiếp D1 binding.

## Validation và an toàn SQL

`D1Query` hỗ trợ filter/sort động nên tên field có thể đi vào câu SQL. Adapter chung chặn field lạ trước khi gọi datasource:

- Tasks chỉ chấp nhận `title`, `status`, `assignee_id`, `created_at` và `id`.
- Incidents chỉ chấp nhận `elevator_id`, `title`, `severity`, `status`, `created_at` và `id`.
- Body chỉ giữ các field ghi được của từng service.
- Table name được khai báo cố định trong service, không lấy từ request.

Đây là allowlist ở tầng transport. Production vẫn nên thêm schema validation cho kiểu, độ dài và business rules.

## Authentication boundary

Service Binding làm service không cần public URL, nhưng không thay thế authentication. Cloudflare Access context không tự truyền từ caller sang downstream Worker.

Thiết kế production nên:

1. Xác thực token hoặc Access assertion tại Gateway.
2. Chuẩn hóa identity thành internal headers hoặc RPC arguments đã ký/kiểm soát.
3. Loại bỏ các identity header do client tự gửi trước khi forward.
4. Thực hiện authorization theo resource/action ở Gateway hoặc service phù hợp.

Example triển khai bước 1 và 3: Gateway xác thực bearer token (`shared/authenticate.ts`), và
router realtime luôn ghi đè header principal. Authorization theo resource vẫn thuộc về service.

## Realtime

```text
client ══ WS ══▶ Gateway ── CloudflareRealtimeRouter ──▶ RealtimeGatewayDO (shard theo principal)
client ── GET ─▶ Gateway ── service ── 200 ──▶ register(ref, x-lcid, x-lgid) ──▶ shard có id = x-lgid
client ── POST ▶ Gateway ── service ── 201 {item} ──▶ waitUntil(publish) ──▶ mọi shard
```

- Durable Object dùng `HibernatableWebsocketGateway`: gateway id là id của object, subscription
  lưu trong storage, ping được runtime trả lời nên shard rảnh không bị đánh thức.
- `register` được await trước khi trả response GET; `publish` chạy qua `waitUntil` để không làm
  chậm write.
- Service không biết gì về realtime. Nếu service cần tự phát change (queue, cron), nó thêm Durable
  Object binding với `script_name: "livequery-api-gateway"` và dùng `CloudflareRealtimePublisher`.
  Khi đó deploy Gateway trước service lần đầu, vì binding cần class đã tồn tại.

## Phần chưa có

- Authorization theo resource/action.
- Queue cho công việc nền.
- Cache, rate limiting và API Shield.
- Distributed tracing correlation ID giữa các service.

Những phần này có thể bổ sung độc lập mà không thay đổi contract D1 hiện tại.
