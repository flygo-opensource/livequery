# API gateway và service API trên Node.js và Bun

Một API gateway và một service API (CRUD task có realtime) chạy ở hai process riêng. Cùng một
code dùng chung, viết hai lần cho hai runtime:

| | Node.js | Bun |
| --- | --- | --- |
| Import | `@livequery/core/node` | `@livequery/core/bun` |
| HTTP server | `http.createServer` | `Bun.serve` |
| Realtime gateway | `WebsocketGateway` (package `ws`) | `BunWebsocketGateway` |
| Gateway | [node/gateway.ts](node/gateway.ts) | [bun/gateway.ts](bun/gateway.ts) |
| Service | [node/service.ts](node/service.ts) | [bun/service.ts](bun/service.ts) |

Gateway và service không cần cùng runtime: gateway Node chạy với service Bun và ngược lại.

## Kiến trúc

```text
                       HTTP discovery (register + heartbeat)
   service :8081  ─────────────────────────────────────────▶  gateway registry :12001
      ▲   ▲                                                          │
      │   └──────── WebSocket gateway-to-gateway ◀──────────────────┤
      │                                                              ▼
      └──────── proxy HTTP ◀──────────────── gateway :8080 ◀── client (HTTP + WebSocket)
```

1. **Service khởi động**: `ApiServiceLinker` gửi host, port, route và endpoint realtime tới
   registry của gateway (`HttpDiscovery`, `listen: false`), rồi heartbeat định kỳ.
2. **Gateway** (`ApiGatewayHandler`) nghe registry (`HttpDiscovery`, `listen: true`), dựng bảng
   route, proxy HTTP tới service, và mở WebSocket tới realtime gateway của service.
3. **Client** chỉ nói chuyện với gateway: mở WebSocket `/livequery/realtime-updates`, gửi
   `start`, nhận `hello` có `gid`, rồi gửi mọi GET kèm `x-lcid` (client id) và `x-lgid` (`gid`).
4. **Service** xử lý GET xong thì gọi `realtime.handle(ctx)` để đăng ký client cho ref đó qua
   đường WebSocket với gateway. Mỗi lần ghi, `TaskStore` phát change, service đẩy vào
   `realtime.next(change)`, change đi qua gateway tới đúng client.

## Code dùng chung

| File | Vai trò |
| --- | --- |
| [shared/TaskStore.ts](shared/TaskStore.ts) | Bảng task trong bộ nhớ, phát `changes$`. Thay bằng datasource thật (MongoDB, Postgres) khi cần |
| [shared/handleTaskRequest.ts](shared/handleTaskRequest.ts) | Toàn bộ API của service dưới dạng Fetch handler, dùng `LivequeryRequestParser` |
| [shared/withCors.ts](shared/withCors.ts) | CORS cho gateway, cho phép header `x-lcid` / `x-lgid` |
| [shared/config.ts](shared/config.ts) | Port và địa chỉ registry, đổi qua biến môi trường |

## Chạy

Từ thư mục `examples`, mở hai terminal:

```bash
node api-gateway/node/gateway.ts
```

```bash
node api-gateway/node/service.ts
```

Bản Bun: thay `node api-gateway/node/...` bằng `bun api-gateway/bun/...`. Node cần bản 22.18 trở
lên để chạy trực tiếp file `.ts`.

Thử:

```bash
curl -X POST localhost:8080/livequery/tasks -H 'content-type: application/json' -d '{"title":"Viết tài liệu"}'
curl localhost:8080/livequery/tasks
curl -X PATCH localhost:8080/livequery/tasks/<id> -H 'content-type: application/json' -d '{"status":"done"}'
```

## Biến môi trường

| Tên | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `GATEWAY_PORT` | `8080` | Port của gateway |
| `SERVICE_PORT` | `8081` | Port của service |
| `OHAYO_DISCOVERY_PORT` | `12001` | Port registry discovery trên gateway |
| `DISCOVERY_URL` | `http://127.0.0.1:12001` | Service gửi đăng ký tới đây |
| `OHAYO_DISCOVERY_KEY` | `livequery` | Khóa HMAC ký bản tin discovery. **Đặt giá trị riêng ở production** |
| `OHAYO_DISCOVERY_NAMESPACE` | `default` | Gateway chỉ nhận service cùng namespace |
| `OHAYO_SERVICE_HOST` | địa chỉ nguồn của request đăng ký | Host gateway dùng để gọi service |

## Test

```bash
bun test api-gateway/e2e.test.ts
```

Test chạy đủ bốn tổ hợp gateway/service trên Node và Bun: CRUD qua gateway, realtime `added` /
`modified` / `removed` tới client, lỗi validation, 404 và CORS preflight.

## Giới hạn

- Chưa có xác thực. Đặt kiểm tra token trong `fetch` của gateway trước khi gọi `gateway.fetch`.
- `TaskStore` nằm trong bộ nhớ: chạy nhiều bản sao service thì mỗi bản có dữ liệu riêng.
- Discovery qua HTTP cần service biết địa chỉ registry. Trong LAN có thể dùng
  `UdpDiscovery` từ `@livequery/core/udp` (cần `@ohayo/udp`), xem `examples/udp-auto-discovery`.
