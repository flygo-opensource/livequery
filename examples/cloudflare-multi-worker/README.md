# Livequery Cloudflare multi-worker example

Example này minh họa một codebase nhưng deploy thành ba Cloudflare Worker độc lập:

```text
Client ── HTTP + WebSocket
  └─> livequery-api-gateway (public, xác thực token)
       ├─> REALTIME ─> RealtimeGatewayDO × N shard (Durable Object, hibernation)
       ├─> TASKS_SERVICE
       │    └─> livequery-tasks-service-api (private) ─> TASKS_DB
       └─> INCIDENTS_SERVICE
            └─> livequery-incidents-service-api (private) ─> INCIDENTS_DB
```

Gateway định tuyến **theo tiền tố path**, khai báo trong `shared/routing.json`:

```json
{ "services": { "tasks": { "binding": "TASKS_SERVICE" } },
  "routes": { "livequery": { "tasks": { "$service": "tasks" } } } }
```

Service sở hữu mọi route nằm dưới tiền tố của nó, nên **thêm route con chỉ cần deploy service**.
Chỉ khi thêm service mới thì gateway mới phải deploy lại, vì cần thêm Service Binding.

Mỗi service là một chuỗi middleware (`shared/resource.ts`):

```ts
app.get('/livequery/tasks', validator(Task, { patch }), livequery(), d1({ binding, table }), realtime())
```

`realtime()` không tham số nên service chỉ gắn header `x-livequery-ref` (sau khi đọc) và
`x-livequery-change` (sau khi ghi). Gateway đọc hai header đó để subscribe và publish, rồi xóa
chúng trước khi trả về client. Nhờ vậy service không cần biết gì về Durable Object, và thứ tự
deploy vẫn là service trước, gateway sau.

## Tài liệu

- [Kiến trúc và luồng xử lý](./docs/architecture.md)
- [API reference](./docs/api.md)
- [Local development và deployment runbook](./docs/deployment.md)

## Cấu trúc thư mục

```text
cloudflare-multi-worker/
├── api-gateway-worker/
│   ├── src/index.ts            # route proxy, auth, realtime sync
│   ├── src/RealtimeGatewayDO.ts # Durable Object shard
│   ├── src/createRealtime.ts   # router + publisher
│   ├── .dev.vars.example
│   └── wrangler.jsonc
├── tasks-service-api-worker/
│   ├── migrations/0001_create_tasks.sql
│   ├── src/index.ts
│   └── wrangler.jsonc
├── incidents-service-api-worker/
│   ├── migrations/0001_create_incidents.sql
│   ├── src/index.ts
│   └── wrangler.jsonc
├── shared/
│   ├── authenticate.ts
│   ├── d1-service.ts
│   ├── routes.test.ts
│   └── routes.ts
└── docs/
```

## Chạy nhanh

Từ thư mục gốc của repo:

```bash
bun install
cd examples
bun run cloudflare:types
bun run cloudflare:migrate:local:tasks
bun run cloudflare:migrate:local:incidents
cp cloudflare-multi-worker/api-gateway-worker/.dev.vars.example cloudflare-multi-worker/api-gateway-worker/.dev.vars
bun run cloudflare:dev
```

Gateway chạy tại `http://localhost:8787`. Kiểm tra:

```bash
curl http://localhost:8787/health

curl -X POST http://localhost:8787/livequery/tasks \
  -H 'authorization: Bearer dev-token' \
  -H 'content-type: application/json' \
  -d '{"title":"Kiểm tra thang A01","status":"todo"}'

curl 'http://localhost:8787/livequery/tasks?:page=1&:limit=20&created_at:sort=desc' \
  -H 'authorization: Bearer dev-token'
```

Realtime từ client:

```ts
const ws = new WebSocket('ws://localhost:8787/livequery/realtime-updates?token=dev-token')
ws.onopen = () => ws.send(JSON.stringify({ event: 'start', data: { id: client_id } }))
// Nhận { event: 'hello', gid } rồi gửi mọi GET kèm x-lcid: client_id và x-lgid: gid.
// Sau đó mỗi thay đổi trên ref đã đọc đến dưới dạng { event: 'sync', data: { changes } }.
```

## Kiểm tra trước deploy

Tại thư mục `examples`:

```bash
bun run cloudflare:types:check
bun run typecheck
bun run test
bun run cloudflare:dry-run
```

## Deploy nhanh

Các Worker được deploy riêng. Lần đầu phải deploy hai service trước để Gateway có target cho Service Bindings:

```bash
bunx wrangler login
bunx wrangler secret put API_TOKENS -c cloudflare-multi-worker/api-gateway-worker/wrangler.jsonc
bun run cloudflare:deploy:tasks
bun run cloudflare:deploy:incidents
bun run cloudflare:migrate:tasks
bun run cloudflare:migrate:incidents
bun run cloudflare:deploy:gateway
```

Xem [deployment runbook](./docs/deployment.md) trước khi dùng trong CI hoặc production.

## Giới hạn của example

- Route dispatch là static, được khai báo trong `shared/routes.ts`.
- Thêm service mới cần thêm Service Binding và deploy lại Gateway.
- Authentication là bearer token so với danh sách `API_TOKENS`; chưa có authorization theo resource, rate limiting.
- Change chỉ được phát khi write đi qua Gateway. Write từ queue hoặc cron phải tự gọi `publish`
  qua một Durable Object binding tới `RealtimeGatewayDO` (`script_name: "livequery-api-gateway"`).
- Hai service không public qua `workers.dev` và preview URL, nhưng vẫn phải kiểm tra quyền ở Gateway; không được coi request nội bộ là đã xác thực.
- Collection query thực hiện thêm truy vấn `COUNT(*)` để trả `count.total`; xem phần phân trang trong [API reference](./docs/api.md).

## Tài liệu Cloudflare liên quan

- [Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- [Developing with multiple Workers](https://developers.cloudflare.com/workers/local-development/multi-workers/)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Monorepo and advanced build setups](https://developers.cloudflare.com/workers/ci-cd/builds/advanced-setups/)
