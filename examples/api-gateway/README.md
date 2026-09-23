# API gateway và service API trên Node.js và Bun

Một API gateway và một service API (CRUD task có realtime) chạy ở hai process riêng. **Cùng một
file chạy trên cả Node lẫn Bun**, không có nhánh điều kiện nào theo runtime:

```bash
node api-gateway/gateway.ts     # hoặc: bun api-gateway/gateway.ts
node api-gateway/service.ts     # hoặc: bun api-gateway/service.ts
```

Chạy từ thư mục `examples`. Node cần bản 22.18 trở lên để chạy thẳng file `.ts`.

## Cách hoạt động

```text
client ── HTTP ──▶ gateway :8080 ──▶ service :8081        (theo tiền tố path trong routing.json)
       ◀─ 200 + x-livequery-ref / x-livequery-change ◀────┘
   │            gateway đọc hai header đó rồi xóa: subscribe sau khi đọc, publish sau khi ghi
   └── WebSocket ──▶ gateway (realtime gateway trong process)
```

| File | Vai trò |
| --- | --- |
| [service.ts](service.ts) | `validator` → `livequery` → datasource → `realtime()`. Không tham số, nên service chỉ gắn header |
| [gateway.ts](gateway.ts) | CORS, `gateway({ routing, realtime })`, và realtime gateway giữ WebSocket của client |
| [shared/routing.json](shared/routing.json) | Service nào sở hữu tiền tố nào |
| [shared/memory.ts](shared/memory.ts) | Datasource trong bộ nhớ, viết đúng hình dạng của `d1()` |
| [shared/TaskStore.ts](shared/TaskStore.ts) | Bảng task trong bộ nhớ, thay cho MongoDB/Postgres/D1 |

Hai thứ giúp cùng một file chạy được mọi runtime:

- `serve(app, { port, realtime })` đến từ bản build tương ứng với runtime (chọn qua export
  condition `node`, `bun`, `workerd`). Trên Node nó mở `http.createServer`; trên Bun nó trả về
  object mà `Bun.serve` nhận từ default export; trên Worker nó trả lại chính app.
- `realtimeGateway()` tạo gateway realtime của runtime đó: `ws` trên Node, `Bun.serve` trên Bun.

Muốn chuyển sang Cloudflare thì `service.ts` giữ nguyên, chỉ đổi `memory(store)` thành `d1()`;
`gateway.ts` đổi realtime sang Durable Object, xem [`examples/cloudflare-multi-worker`](../cloudflare-multi-worker/README.md).

## Thêm route mà không phải động vào gateway

Gateway chỉ biết **tiền tố** `/livequery/tasks` thuộc service nào. Thêm `/livequery/tasks/:id/comments`
hay một action `~complete` vào `service.ts` là dùng được ngay, không cần khởi động lại gateway.

## Gateway tự nhận biết service (UDP)

Trên Node/Bun (Linux), đặt `DISCOVERY=udp` và cùng một `SIMPLE_DISCOVERY_KEY` cho cả hai process:
service tự thông báo tên, cổng và các route `/livequery/*` của nó qua
[`@livequery/discovery`](../../packages/discovery/README.md), gateway học từ đó thay vì đọc
`routing.json`. Thêm service, hay chạy thêm instance, không phải sửa gateway; các instance cùng tên
chia tải lần lượt. Không có heartbeat: service thông báo một lần, gateway tự mở một kết nối TCP tới
nó và giữ kết nối đó — service dừng, crash hay bị kill thì kết nối đóng và gateway gỡ ngay; mất kết
nối mà service vẫn sống thì gateway tự nối lại.

```bash
DISCOVERY=udp SIMPLE_DISCOVERY_KEY=bi-mat node api-gateway/service.ts
DISCOVERY=udp SIMPLE_DISCOVERY_KEY=bi-mat bun  api-gateway/gateway.ts
```

Cloudflare giữ routing khai báo (Service Binding), không dùng discovery.

## Biến môi trường

| Tên | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `GATEWAY_PORT` | `8080` | Port của gateway |
| `SERVICE_PORT` | `8081` | Port của service |
| `SERVICE_URL` | `http://127.0.0.1:8081` | Địa chỉ gateway dùng để gọi service, ghi đè giá trị trong `routing.json` |
| `DISCOVERY` | – | `udp`: service tự thông báo, gateway tự nhận biết (bỏ qua `routing.json`, `SERVICE_URL`) |
| `SIMPLE_DISCOVERY_KEY` | – | Khoá ký gói discovery, giống nhau ở gateway và service. Luôn đặt khi dùng `DISCOVERY` |

## Test

```bash
bun test api-gateway/e2e.test.ts
```

Chạy đủ bốn tổ hợp gateway/service trên Node và Bun, mỗi tổ hợp hai lần: routing khai báo và `DISCOVERY=udp` (khoá, cổng UDP riêng cho mỗi lần chạy). Mỗi lần kiểm tra: CRUD qua gateway,
realtime `added`/`modified`/`removed` tới client, giá trị mặc định của schema, từ chối field lạ và
dữ liệu sai, 404 cho path không service nào sở hữu, header nội bộ bị xóa, và CORS preflight.

## Giới hạn

- Chưa có xác thực. Thêm một middleware trước `gateway()` và truyền `principal` vào nếu cần.
- `TaskStore` nằm trong bộ nhớ nên chạy nhiều bản sao service thì mỗi bản có dữ liệu riêng.
- Gateway dùng bảng tiền tố tĩnh: thêm service mới thì sửa `routing.json`. Discovery lúc chạy đã
  bị gỡ, xem [DESIGN.md](../../DESIGN.md) mục 8.
