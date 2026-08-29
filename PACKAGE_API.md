# Public classes and symbols by package

Tài liệu này liệt kê public runtime class của từng package. Những package chủ ý
không có class được ghi rõ cùng function/interface thay thế.

## `@livequery/protocol`

### `LivequeryRequestParser`

Chuyển `RawRequest` thành `LivequeryRequest` chuẩn hóa. Parser xác định ref,
collection/document, document id, route schema, query, body và custom action
`~verb`. Có thể dùng `LivequeryRequestParser.parse(request)` hoặc đặt instance
vào handler pipeline.

Các symbol quan trọng khác:

- `LivequeryContext`, `LivequeryHandler`: contract của request pipeline.
- `LivequeryDatasource`: contract cho database/framework datasource adapter.
- `LivequeryBaseEntity`, `UpdatedData`, `DatabaseEvent`: entity và change-event types.
- `LivequeryRealtimeEvent`, `RealtimeSubscription`: WebSocket wire contracts.
- `QueryOption`, `FilterConditions`: type-safe query/filter types.
- `hidePrivateFields`, `hidePrivateFieldsInItem`: loại bỏ private fields trước response.

## `@livequery/service`

### `ApiServiceLinker`

Quản lý lifecycle publication của một application service. `start()`, `ready()`,
`draining()` và `close()` phát manifest tương ứng; `update()` thay đổi version,
endpoint, routes, health hoặc realtime metadata. Class chỉ phụ thuộc
`ServicePublisher`, không biết gateway vendor.

### `NoopServicePublisher`

Publisher không tạo external side effect. Dùng khi CI/CD đã lấy manifest và cấu
hình gateway ở deploy time, ví dụ Kubernetes hoặc Cloudflare.

Các contract:

- `ServicePublisher`: interface `publish(manifest)` và optional `close()`.
- `ServiceManifest`: source of truth của service instance, routes và lifecycle.
- `NetworkServiceEndpoint`: upstream có protocol/host/port.
- `BindingServiceEndpoint`: deploy-time binding như Cloudflare Service Binding.

## `@livequery/discovery`

Package này không có runtime class. Nó chỉ cung cấp contract chung:

- `Discovery<T>`: observable transport với `broadcast()` và `close()`.
- `DiscoveryMessage<T>`: Ohayo envelope có node, namespace, tags, version và seq.
- `DiscoveryOfflineData`: offline event marker.
- `hasDiscoveryEnvelope`: kiểm tra envelope tối thiểu.
- `isDiscoveryOfflineData`: type guard cho offline event.
- `containsAllTags`: kiểm tra contains-all tag semantics.

## `@livequery/discovery-http`

### `HttpDiscovery<T>`

HTTP discovery transport hai chế độ. Gateway-side `listen: true` mở registry,
health và node snapshot endpoints. Service-side `listen: false` gửi register,
heartbeat, retry và deregister tới một hoặc nhiều registry. `status$` phát
`not_ready`, `ready`, `closed`.

### `HttpServicePublisher`

Adapter từ `ServicePublisher` sang `HttpDiscovery<ServiceManifest>`. Nó tạo Ohayo
envelope từ manifest và giữ discovery instance theo `instanceId`.

## `@livequery/discovery-file`

### `FileServicePublisher`

Ghi một JSON file cho mỗi service instance bằng temporary file và atomic rename.
`close()` xóa file của instance. Class chỉ publish; agent watcher và gateway reload
nằm ngoài application process.

## `@livequery/gateway`

### `ApiGatewayHandler`

Fetch API gateway engine. `register()`/`applyManifest()` thêm ready service,
`deregister()` loại instance, `fetch()` match route và forward request. Class xử
lý route priority, ownership conflict, round-robin, failover và timeout nhưng
không mở server.

### `DiscoveryGatewayRegistry`

Bridge một `Discovery<ServiceManifest>` vào `ApiGatewayHandler`. Online/ready
manifest được apply; offline event deregister instance. `close()` chỉ hủy
subscription bridge.

### `RouteConflictError`

Error chuyên biệt khi hai logical service khác nhau khai báo cùng normalized
HTTP method/path.

## `@livequery/realtime`

### `WebsocketGatewayBase`

Runtime-neutral realtime protocol engine, kế thừa `Subject<UpdatedData>`. Class
quản lý socket handshake, subscriptions, unsubscribe, reconnect grace period,
gateway-to-gateway connection, Observable link và phát sync events. Runtime
adapter gọi `onConnection`, `onMessage` và `onClose`.

Các contract:

- `SocketLike`: WebSocket tối thiểu mà runtime adapter phải bọc.
- `RealtimeEventPublisher`: contract publish change event vào broker.
- `RealtimeEventConsumer`: contract consume broker event.
- `LivequeryChangeEvent`: event envelope độc lập NATS/Redis/Kafka.

## `@livequery/realtime-node`

### `WebsocketGateway`

Node adapter kế thừa `WebsocketGatewayBase`, dùng package `ws` và gắn vào
`http.Server`. `attach()` hỗ trợ bind/rebind; `close()` đóng clients và tháo
WebSocket server.

## `@livequery/realtime-bun`

### `BunWebsocketGateway`

Bun-native adapter kế thừa `WebsocketGatewayBase`. `serve()` mở standalone
`Bun.serve`; `attachBunUpgrade()` và `getBunWebsocketHandlers()` cho phép dùng
chung application server. `path` xác định endpoint được phép upgrade.

## `@livequery/realtime-cloudflare`

### `CloudflareRealtimeRouter`

Stateless public-Worker router. Class xác minh WebSocket upgrade, lấy bounded
shard key và forward request tới Durable Object tương ứng qua namespace binding.

### `EdgeWebsocketGateway`

`WebSocketPair` adapter kế thừa `WebsocketGatewayBase`. `handleRequest()` accept
upgrade và chuyển socket events vào protocol engine. Production phải khởi tạo
class bên trong Durable Object, không tạo mới theo từng public Worker request.

Các contract `DurableObjectNamespaceLike` và `DurableObjectStubLike` giữ package
độc lập với phiên bản cụ thể của Cloudflare type definitions.

## `@livequery/gateway-controller`

Package này không có class. `createServiceTopology(manifests)` validate ownership,
lọc ready instances và collapse replicas thành `ServiceTopology` dùng chung cho
vendor renderers.

## `@livequery/gateway-controller-nginx`

Không có class. `renderNginxConfig(manifests)` trả về Nginx config string gồm
upstream, targets, regex locations, allowed methods và proxy headers. Function
không ghi file hoặc reload Nginx.

## `@livequery/gateway-controller-kong`

Không có class. `renderKongConfig(manifests)` trả về Kong declarative object với
format version, upstreams, targets, services và routes. Function không gọi Kong
Admin API.

## `@livequery/gateway-controller-cloudflare`

Không có class. `renderCloudflarePlan(manifests)` tạo danh sách service binding và
HTTP routes để CI/Wrangler/Terraform apply. Function không deploy Worker và không
quản lý Durable Object WebSocket state.
