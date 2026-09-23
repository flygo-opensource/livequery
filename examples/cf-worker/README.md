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

- `src/index.ts`: schema `Task`, chuỗi middleware cho từng route, xử lý lỗi.
- `src/authenticate.ts`: xác thực bearer token (và token trên query string cho WebSocket).
- `src/requireAuth.ts`: `requireAuth()` và hai guard phân quyền, `requireSelf` và `requireOwnedTask`.
- `src/createRealtime.ts`: router và publisher, số shard lấy từ `REALTIME_SHARDS`.
- `src/RealtimeGatewayDO.ts`: một shard realtime (hibernation + alarm).

Mỗi route là một guard cộng một chuỗi middleware:

```ts
app.get('/livequery/users/:owner/tasks', requireSelf('owner'), validator(Task), livequery(), d1(), realtime(shards))
```

- `requireSelf('owner')` khẳng định đoạn path đó chính là principal đã xác thực.
- `validator(Task)` kiểm tra body, và schema đó cũng là danh sách cột được phép lọc, sắp xếp, ghi.
- `livequery()` phân tích request thành `c.var.livequery`.
- `d1()` chạy thao tác tương ứng với method, dựng response, rồi chạy tiếp phần còn lại của chuỗi.
- `realtime(shards)` đăng ký client sau khi đọc, và publish sau khi ghi (qua `waitUntil`).

### Phân quyền

| Route | Guard | Vì sao |
| --- | --- | --- |
| `/livequery/users/:owner/tasks` | `requireSelf('owner')` | `owner` là route key → thành `WHERE owner = ?` khi đọc, và được ghi vào row khi insert. Phủ cả collection lẫn realtime ref. |
| `/livequery/users/:owner/status/:status/tasks` | `requireSelf('owner')` | Cùng scope, `:status` thành mệnh đề WHERE thứ hai. |
| `/livequery/tasks/:id` | `requireOwnedTask()` | Path không mang `owner`, nên guard phải đọc row rồi mới quyết định. Chỉ dùng được cho document. |

`owner` **không** có trong schema `Task`. Nó được phân quyền từ path; nếu client gửi được nó trong
body thì client đang tự chọn chủ sở hữu.

Schema dùng `zod/mini` cho nhẹ: bundle 239 KB. Bản `zod` đầy đủ tốn thêm khoảng 110 KB sau gzip.
Thư viện nào theo chuẩn Standard Schema cũng dùng được (zod, valibot, arktype).

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
- `requireOwnedTask()` tốn thêm một lần đọc D1 mỗi request document. Đổi lại nó là
  cách duy nhất phân quyền một route không mang chủ sở hữu trên path.
- Principal ở đây là `token:<32 hex>`, nên nó nằm ngay trong URL của route scope theo
  owner. Với hệ thống thật, dùng user id thay cho hash token.
- Ghi thẳng vào D1 (dashboard, migration, script) không sinh realtime — D1 không có
  change feed, realtime chỉ đến từ đường ghi qua API.
