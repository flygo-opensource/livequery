# Public classes and symbols

Livequery phát hành một package lõi, `@livequery/core`, chia theo entry point.
Mỗi entry chỉ kéo phần runtime của nó: import root hoặc `/workers` không đụng tới
Node built-in, `ws` hay UDP.

| Entry | Chạy trên | Nội dung |
| --- | --- | --- |
| `@livequery/core` | Mọi runtime | Contract, parser, realtime protocol engine |
| `@livequery/core/node` | Node.js | Root + gateway `ws`, discovery HTTP, API gateway |
| `@livequery/core/bun` | Bun | Root + gateway `Bun.serve`, discovery HTTP, API gateway |
| `@livequery/core/udp` | Node.js, Bun | `UdpDiscovery` (cần `@ohayo/udp`) |
| `@livequery/core/workers` | Cloudflare Workers | Root + gateway Durable Object, router, publisher |

`ws` và `@ohayo/udp` là optional peer dependency: cài `ws` khi dùng
`WebsocketGateway` của `/node`, cài `@ohayo/udp` khi dùng `/udp`. Import `/node` hay `/bun` không
bao giờ nạp `@ohayo/udp`.

Package ngoài core: datasource (`@livequery/d1`, `@livequery/mongodb`,
`@livequery/postgres`) và framework adapter (`@livequery/nestjs`,
`@livequery/honojs`).

## `@livequery/core`

### `LivequeryRequestParser`

Chuyển `RawRequest` thành `LivequeryRequest` chuẩn hóa. Parser xác định ref,
collection/document, document id, route schema, query, body và custom action
`~verb`. Có thể dùng `LivequeryRequestParser.parse(request)` hoặc đặt instance
vào handler pipeline.

### `WebsocketGatewayBase`

Realtime protocol engine không phụ thuộc runtime, kế thừa `Subject<UpdatedData>`.
Class quản lý handshake, subscription, unsubscribe, reconnect grace period, kết nối
gateway-to-gateway, Observable link và phát `sync`. Runtime adapter gọi
`onConnection`, `onMessage` và `onClose`. Frame nhận vào có thể là JSON hoặc
msgpack (client chuyển sang msgpack khi `hello.binary` là true).

Option: `disconnectGraceMs`, `id` (gateway id cố định), `binary` (giá trị
`hello.binary`).

Các symbol khác:

- `LivequeryContext`, `LivequeryHandler`, `LivequeryDatasource`: contract của request pipeline và datasource.
- `LivequeryBaseEntity`, `UpdatedData`, `DatabaseEvent`: entity và change-event types.
- `LivequeryRealtimeEvent`, `RealtimeSubscription`, `LIVEQUERY_REALTIME_PATH`: WebSocket wire contracts.
- `QueryOption`, `FilterConditions`: type-safe query/filter types.
- `hidePrivateFields`, `hidePrivateFieldsInItem`: bỏ field private trước khi trả response.
- `Discovery<T>`, `DiscoveryMessage<T>`, `isDiscoveryOfflineData`, `hasDiscoveryEnvelope`, `containsAllTags`: contract discovery.
- `RealtimeEventPublisher`, `RealtimeEventConsumer`, `LivequeryChangeEvent`: contract broker (NATS/Redis/Kafka).
- `decodeMsgpack`, `decodeRealtimeFrame`: giải mã frame realtime, không dependency.
- `SocketLike`: WebSocket tối thiểu mà adapter phải bọc.

### `matchService(routing, pathname)`

Tìm service sở hữu một path, đi theo tree `ServiceRouting` từng đoạn một và giữ `$service` sâu
nhất. Dùng cho gateway định tuyến theo tiền tố: service thêm route con không cần deploy lại
gateway. `LIVEQUERY_REF_HEADER` và `LIVEQUERY_CHANGE_HEADER` là hai header service dùng để báo
gateway cần subscribe hay publish.

### `toLivequeryError(thrown)`

Chuẩn hóa mọi thứ bị ném thành `Error` có `status` và `code`. Datasource ném object thuần
`{ status, code, message }`, mà framework chỉ đưa `Error` vào error handler.

## `@livequery/core/node`

### `WebsocketGateway`

Adapter Node kế thừa `WebsocketGatewayBase`, dùng package `ws` và gắn vào
`http.Server`. `attach()` hỗ trợ bind/rebind; `close()` đóng client và tháo
WebSocket server.

### `ApiGatewayHandler`

API gateway cho Node/Bun. Nghe discovery để dựng bảng route, proxy HTTP tới
`host:port` của service với timeout, round-robin giữa bản sao, cô lập node lỗi và
mở WebSocket gateway-to-gateway tới realtime gateway của từng service.

### `ApiServiceLinker`

Phía service: phát metadata (host, port, route, thông tin WebSocket gateway) qua
discovery và phát lại khi thấy gateway mới.

### `HttpDiscovery<T>`

Transport discovery qua HTTP, hai chế độ: gateway `listen: true` mở registry, service
`listen: false` gửi register/heartbeat tới `gateways`.

## `@livequery/core/udp`

### `UdpDiscovery`

Re-export từ `@ohayo/udp`: discovery multicast có ký trong LAN. Tách entry riêng để `/node` và
`/bun` không phụ thuộc `@ohayo/udp`.

## `@livequery/core/bun`

### `BunWebsocketGateway`

Adapter Bun kế thừa `WebsocketGatewayBase`. `new BunWebsocketGateway({ port })`
mở `Bun.serve` riêng; `attachBunUpgrade()` và `getBunWebsocketHandlers()` dùng
chung server có sẵn. `path` quy định endpoint được upgrade. Cũng được export với
tên `WebsocketGateway` để đổi từ `/node` sang `/bun` chỉ cần đổi đường import.

Entry này còn export `ApiGatewayHandler`, `ApiServiceLinker`, `HttpDiscovery` như `/node`.

## `@livequery/core/workers`

### `HibernatableWebsocketGateway`

Gateway chạy trong Durable Object, dùng WebSocket Hibernation API. Gateway id là id
của Durable Object, socket lưu `client_id` và principal trong attachment,
subscription lưu trong storage, nên object bị evict hay deploy lại vẫn giữ realtime.
`fetch()` xử lý upgrade và hai endpoint nội bộ broadcast/subscribe; `register()`
từ chối subscription khác principal. `alarm()` xóa subscription của client hết cửa sổ chờ
reconnect và quét định kỳ bản ghi không còn socket, nên object ngủ được trong lúc chờ.

### `CloudflareRealtimeRouter`

Chạy ở Worker public. Chỉ chuyển WebSocket upgrade tới shard do `shardKey` chọn và
ghi đè header principal bằng giá trị Worker đã xác thực.

### `CloudflareRealtimePublisher`

Chạy ở Worker. `register()` đăng ký subscription tới gateway theo `x-lgid` sau một
lần đọc đã phân quyền; `publish()` phát change tới các shard.

### `EdgeWebsocketGateway`

Adapter `WebSocketPair` không hibernate, state chỉ nằm trong memory. Giữ để tương
thích; code mới dùng `HibernatableWebsocketGateway`.

Các contract `DurableObjectStateLike`, `DurableObjectNamespaceLike`,
`HibernatableWebSocket` giữ core độc lập với phiên bản của Cloudflare type
definitions.
