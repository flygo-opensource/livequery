# livequery-worker

Worker mẫu chạy Livequery hoàn toàn trên Cloudflare: REST trên D1, realtime qua
Durable Object dùng WebSocket Hibernation API. Bundle không cần `nodejs_compat`.

## Kiến trúc

```text
client ── HTTP ──▶ Worker ── D1Datasource ──▶ D1
   │                 │
   │                 ├─ GET thành công ─▶ register(x-lcid, x-lgid) ─▶ DO có id = x-lgid
   │                 └─ ghi thành công ─▶ waitUntil(publish) ───────▶ mọi shard DO
   │
   └── WebSocket ──▶ Worker ── router (shard theo principal) ──▶ RealtimeGatewayDO
```

- `src/index.ts`: route Hono, allowlist cột `TASK_FIELDS`, xử lý lỗi (lỗi 5xx chỉ
  ghi log, không trả chi tiết cho client).
- `src/authenticate.ts`, `src/requireAuth.ts`: xác thực bearer token.
- `src/createRealtime.ts`: router và publisher, số shard lấy từ `REALTIME_SHARDS`.
- `src/subscribe.ts`: đăng ký subscription, được `await` trước khi trả response GET.
- `src/broadcast.ts`: phát change qua `waitUntil` để runtime không hủy giữa chừng.
- `src/RealtimeGatewayDO.ts`: một shard realtime.

## Cấu hình

| Tên | Loại | Ý nghĩa |
| --- | --- | --- |
| `API_TOKENS` | secret | Danh sách bearer token, phân tách bằng dấu phẩy |
| `ALLOW_ANONYMOUS` | var | `"true"` cho phép request không token với principal `anonymous` |
| `REALTIME_SHARDS` | var | Số Durable Object shard, mặc định 4, tối đa 64 |

HTTP gửi token qua `Authorization: Bearer <token>`. Trình duyệt không đặt được
header cho WebSocket, nên URL realtime mang token qua query:
`wss://<host>/livequery/realtime-updates?token=<token>`. Token trong URL có thể xuất
hiện trong log, vì vậy nên dùng token ngắn hạn cho realtime.

Principal là 32 ký tự đầu của SHA-256 của token. Socket và subscription được gắn
với principal, nên client khác token không đăng ký hộ hay chiếm `client_id` được.

## Chạy local

```sh
cp .dev.vars.example .dev.vars
bun run db:init:local
bun run dev
```

## Deploy

```sh
wrangler secret put API_TOKENS
wrangler d1 execute DB --remote --file schema.sql
bun run deploy
```

`wrangler deploy` tự tạo D1 database ở lần deploy đầu vì `wrangler.toml` không ghi
`database_id`. Migration `v1` khai báo `RealtimeGatewayDO` là SQLite-backed Durable
Object.

## Giới hạn

- Mỗi thao tác ghi gọi `REALTIME_SHARDS` subrequest. Với số shard lớn, nên đổi
  `shardKey` và `shards` trong `createRealtime.ts` sang shard theo tenant để một
  change chỉ đến shard của tenant đó.
- Từ lúc GET đọc xong đến lúc `register` hoàn tất có một khoảng hở rất ngắn. Change
  ghi trong khoảng đó không được đẩy cho client vừa đọc.
