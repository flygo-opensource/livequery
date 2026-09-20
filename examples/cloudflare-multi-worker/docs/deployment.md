# Local development và deployment runbook

## Yêu cầu

- Bun theo phiên bản khai báo ở root `package.json`.
- Cloudflare account có quyền deploy Workers và tạo D1.
- Wrangler 4 được cài qua workspace dependencies.
- Đã chạy `bunx wrangler login` trước khi thao tác remote.

Mọi lệnh bên dưới, trừ khi có ghi chú khác, chạy trong thư mục `examples`.

## Cài dependency và sinh binding types

Từ root repo:

```bash
bun install
cd examples
bun run cloudflare:types
```

Không sửa tay các file `worker-configuration.d.ts`. Chạy lại `cloudflare:types` sau khi đổi binding trong bất kỳ `wrangler.jsonc` nào.

Kiểm tra types không bị stale:

```bash
bun run cloudflare:types:check
```

## Khởi tạo database local

```bash
bun run cloudflare:migrate:local:tasks
bun run cloudflare:migrate:local:incidents
```

Chế độ multi-config coi Gateway là primary config và lưu local state ở:

```text
cloudflare-multi-worker/api-gateway-worker/.wrangler/state
```

Hai migration script truyền cùng `--persist-to` này. Binding phải giữ tên riêng `TASKS_DB` và `INCIDENTS_DB`; nếu cùng dùng tên `DB`, local multi-config có thể ánh xạ nhầm hai database vào cùng một state resource.

State local nằm trong `.wrangler/` và đã được gitignore.

## Chạy ba Worker local

```bash
bun run cloudflare:dev
```

Lệnh tương đương:

```bash
wrangler dev \
  -c cloudflare-multi-worker/api-gateway-worker/wrangler.jsonc \
  -c cloudflare-multi-worker/tasks-service-api-worker/wrangler.jsonc \
  -c cloudflare-multi-worker/incidents-service-api-worker/wrangler.jsonc
```

Gateway đọc token từ `api-gateway-worker/.dev.vars` (copy từ `.dev.vars.example`).

Config đầu tiên là primary Worker, được expose tại `http://localhost:8787`. Hai config sau là secondary Workers và chỉ được gọi qua Service Bindings. Multi-config dev hiện được Cloudflare đánh dấu experimental.

Smoke test:

```bash
curl -fsS http://localhost:8787/health

curl -fsS -X POST http://localhost:8787/livequery/tasks \
  -H 'authorization: Bearer dev-token' \
  -H 'content-type: application/json' \
  -d '{"title":"Local smoke test"}'

curl -fsS 'http://localhost:8787/livequery/tasks?:page=1&:limit=10' \
  -H 'authorization: Bearer dev-token'
```

## Kiểm tra trước deploy

```bash
bun run cloudflare:types:check
bun run typecheck
bun run test
bun run cloudflare:dry-run
```

`cloudflare:dry-run` bundle theo thứ tự Tasks, Incidents rồi Gateway và không thay đổi remote resources.

## Deploy lần đầu

### 1. Đăng nhập

```bash
bunx wrangler login
bunx wrangler whoami
```

### 2. Deploy service Workers

```bash
bun run cloudflare:deploy:tasks
bun run cloudflare:deploy:incidents
```

Hai D1 config cố ý chưa chứa `database_id`. Wrangler 4 có thể tự provision resource trong lần deploy đầu và ghi ID trở lại file config local. Sau lần deploy đầu:

1. Kiểm tra diff của hai `wrangler.jsonc`.
2. Xác nhận đúng account/database.
3. Commit `database_id` hoặc quản lý resource bằng IaC để CI không phụ thuộc auto-provisioning.

### 3. Apply migrations remote

```bash
bun run cloudflare:migrate:tasks
bun run cloudflare:migrate:incidents
```

Migration được theo dõi riêng trong từng D1 database. Không sửa một migration đã apply; tạo migration mới có version tiếp theo.

### 4. Deploy Gateway

```bash
bunx wrangler secret put API_TOKENS -c cloudflare-multi-worker/api-gateway-worker/wrangler.jsonc
bun run cloudflare:deploy:gateway
```

Lần deploy đầu tạo `RealtimeGatewayDO` theo migration `v1` (`new_sqlite_classes`).

Gateway phải deploy sau service trong lần đầu vì Cloudflare cần tìm thấy target Worker được khai báo trong Service Bindings.

### 5. Verify production

Thay `GATEWAY_URL` bằng URL được Wrangler trả về:

```bash
curl -fsS "$GATEWAY_URL/health"
curl -fsS "$GATEWAY_URL/livequery/tasks?:limit=1" -H "authorization: Bearer $TOKEN"
curl -fsS "$GATEWAY_URL/livequery/incidents?:limit=1" -H "authorization: Bearer $TOKEN"
```

Không test trực tiếp URL của service vì cấu hình service tắt `workers_dev` và preview URLs.

## Deploy các lần tiếp theo

Thứ tự an toàn khi thay đổi contract:

1. Thêm thay đổi backward-compatible vào service.
2. Apply migration tương thích với cả code cũ và mới.
3. Deploy service.
4. Deploy Gateway hoặc client dùng contract mới.
5. Ở release sau mới xóa field/route cũ.

Nếu chỉ đổi một service mà không đổi route/binding/contract của Gateway, có thể deploy riêng service đó.

## CI/CD cho monorepo

Nên tạo ba pipeline hoặc ba Cloudflare Builds, mỗi pipeline có deploy command riêng:

| Worker | Deploy command từ root repo |
| --- | --- |
| Tasks | `cd examples && bun run cloudflare:deploy:tasks` |
| Incidents | `cd examples && bun run cloudflare:deploy:incidents` |
| Gateway | `cd examples && bun run cloudflare:deploy:gateway` |

Tất cả pipeline nên chạy trước:

```bash
bun install --frozen-lockfile
cd examples
bun run cloudflare:types:check
bun run typecheck
```

Gợi ý include paths để tránh deploy Worker không liên quan:

| Pipeline | Include paths |
| --- | --- |
| Tasks | `examples/cloudflare-multi-worker/tasks-service-api-worker/**`, `examples/cloudflare-multi-worker/shared/**`, `d1/**`, `core/**`, lockfile |
| Incidents | `examples/cloudflare-multi-worker/incidents-service-api-worker/**`, `examples/cloudflare-multi-worker/shared/**`, `d1/**`, `core/**`, lockfile |
| Gateway | `examples/cloudflare-multi-worker/api-gateway-worker/**`, `examples/cloudflare-multi-worker/shared/routes.ts`, lockfile |

Migration remote nên là release step riêng và chạy trước code yêu cầu schema mới. Không chạy migration đồng thời từ nhiều pipeline.

## Custom domain

Example chưa khai báo `routes` hoặc custom domain trong Gateway config. Có thể cấu hình domain ở Cloudflare dashboard hoặc thêm `routes` vào `api-gateway-worker/wrangler.jsonc`. Chỉ Gateway cần domain public.

Không gắn domain/route public vào hai service trừ khi chủ động thay đổi security boundary.

## Troubleshooting

### Gateway báo downstream không tồn tại khi deploy

Target Worker chưa được deploy hoặc `service` name trong Gateway không khớp `name` của service config. Deploy service trước và so sánh chính xác tên.

### Local request trả `D1_ERROR: no such table`

Migration chưa được apply vào state của primary multi-config. Chạy lại:

```bash
bun run cloudflare:migrate:local:tasks
bun run cloudflare:migrate:local:incidents
```

### Wrangler hiển thị Service Binding `not connected`

Đợi tất cả config bundle xong. Nếu vẫn lỗi, dừng process và chạy lại `bun run cloudflare:dev`. Có thể chạy mỗi Worker trong terminal riêng nếu gặp lỗi từ chế độ multi-config experimental.

### TypeScript không thấy binding mới

```bash
bun run cloudflare:types
bun run typecheck
```

### Gateway trả `404 Route not found`

Route chưa có trong `shared/routes.ts`, method không được khai báo, hoặc service chưa đăng ký Hono route tương ứng. Gateway manifest và service routes phải thay đổi cùng nhau.

### Production trả lỗi sau migration

Kiểm tra Workers Logs/Traces đã bật trong từng `wrangler.jsonc`, xác nhận migration được apply đúng database binding và xem deployment/version gần nhất trước khi rollback code.

## Tài liệu chính thức

- [Service Binding deployment và local development](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Wrangler automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning)
- [Cloudflare Builds advanced setups](https://developers.cloudflare.com/workers/ci-cd/builds/advanced-setups/)
