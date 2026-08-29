# Livequery Deployment Architecture

## 1. Mục tiêu

Thiết kế Livequery phải cho phép một service giữ nguyên mã nguồn và container image
khi hệ thống thay đổi lớp API Gateway:

- Livequery API Gateway của repository.
- Nginx.
- Kong.
- Kubernetes Gateway/Ingress.
- Cloudflare Workers.

Service chỉ công bố một `ServiceManifest` trung lập. Cách phát hiện service và cách
cấu hình gateway là trách nhiệm của publisher, registry và gateway controller.

Thiết kế cũng phải hỗ trợ hai nhu cầu khác nhau:

- Local hoặc pure Linux: service tự xuất hiện và biến mất bằng discovery runtime.
- Production có control plane: cấu hình gateway được reconcile từ desired state,
  có kiểm tra conflict, audit và rollback.

## 2. Nguyên tắc kiến trúc

1. Service không biết đang chạy sau Nginx, Kong hay Livequery Gateway.
2. Manifest là source of truth chung; cấu hình theo vendor là output được sinh ra.
3. Service discovery và load balancing là hai trách nhiệm khác nhau.
4. Trên Kubernetes, gateway trỏ đến logical `Service`, không đăng ký từng Pod.
5. HTTP API Gateway và WebSocket Gateway dùng chung protocol nhưng không chia sẻ
   lifecycle hoặc state bắt buộc.
6. Auto-discovery được ưu tiên cho development và bare-metal; production phải có
   validation, ownership, authentication và desired-state reconciliation.
7. Các header nội bộ phải do gateway ghi đè, không được tin dữ liệu từ client.

## 3. Mô hình thành phần

```text
Application service
        |
        | ServiceManifest
        v
ApiServiceLinker
        |
        +-- FileServicePublisher -----> Manifest Agent
        |
        +-- HttpServicePublisher -----> Service Registry
        |
        `-- NoopServicePublisher ------> CI/CD-only registration

Manifest consumers
        |
        +-- LivequeryGatewayController -> ApiGatewayHandler
        +-- KongGatewayController ------> Kong desired state
        +-- NginxGatewayController -----> nginx.conf + safe reload
        +-- KubernetesController -------> HTTPRoute/Ingress
        `-- CloudflareController --------> Worker bindings/config/routes
```

`ApiServiceLinker` là API cấp cao được service sử dụng. Publisher là transport có
thể thay thế. Gateway controller là consumer và không chạy bên trong application
service.

## 4. ServiceManifest

Manifest không chứa object phụ thuộc Bun, Hono, NestJS, Kong hoặc Nginx.

```ts
export type ServiceManifest = {
  schemaVersion: 1
  serviceId: string
  instanceId: string
  version: string
  protocolVersion: string
  endpoint: {
    kind?: 'network'
    protocol: 'http' | 'https'
    host: string
    port: number
  } | {
    kind: 'binding'
    binding: string
  }
  routes: Array<{
    id: string
    method: string
    path: string
    targetPath?: string
    auth: 'public' | 'required' | 'internal'
    timeoutMs?: number
  }>
  health?: {
    livenessPath: string
    readinessPath: string
  }
  realtime?: {
    enabled: boolean
    publisher?: string
  }
  status: 'starting' | 'ready' | 'draining' | 'offline'
  seq: number
  updatedAt: number
}
```

Ví dụ:

```json
{
  "schemaVersion": 1,
  "serviceId": "users",
  "instanceId": "users-7d9d8f-abc",
  "version": "1.4.2",
  "protocolVersion": "1",
  "endpoint": {
    "protocol": "http",
    "host": "users",
    "port": 3000
  },
  "routes": [
    {
      "id": "users-list",
      "method": "GET",
      "path": "/livequery/users",
      "auth": "required"
    },
    {
      "id": "users-detail",
      "method": "GET",
      "path": "/livequery/users/:id",
      "auth": "required"
    }
  ],
  "health": {
    "livenessPath": "/health",
    "readinessPath": "/ready"
  },
  "realtime": {
    "enabled": true,
    "publisher": "nats"
  },
  "status": "ready",
  "seq": 15,
  "updatedAt": 1787880000000
}
```

### 4.1 Route ownership

Registry phải xác định ownership bằng ít nhất:

```text
serviceId + route.id + method + normalized path + protocolVersion
```

Hai instance của cùng service và cùng definition được coi là replica. Hai service
khác nhau khai báo cùng `method + path` phải bị từ chối, không được tự động đưa vào
cùng một round-robin pool.

### 4.2 Instance và logical service

- `serviceId` xác định service logic và quyền sở hữu route.
- `instanceId` xác định một process, VM, container hoặc Pod.
- Bare-metal có thể cân bằng trực tiếp giữa các `instanceId`.
- Kubernetes nên collapse các instance thành một endpoint logic như
  `http://users:3000`; Kubernetes Service cân bằng Pod.

## 5. ApiServiceLinker và publisher

API service-facing giữ ổn định:

```ts
const linker = new ApiServiceLinker({
  manifest,
  publisher,
})

await linker.start()
await linker.ready()

// Khi shutdown:
await linker.draining()
await server.drain()
await linker.close()
```

### 5.1 UDP development example

Dùng trực tiếp `@ohayo/udp` cho local, pure Linux hoặc private bare-metal
network. Đây là example integration, không phải một package publisher trong
Livequery:

```text
ServiceApiMetadata --signed UDP--> ApiGatewayHandler
```

Yêu cầu:

- Discovery key bắt buộc trong production; không có giá trị mặc định.
- HMAC, timestamp, TTL, `instanceId` và monotonic `seq`.
- Giới hạn kích thước packet và tốc độ nhận.
- Xác minh chữ ký trước khi relay packet.
- Firewall chỉ cho phép private subnet cần thiết.
- Không giả định UDP multicast hoạt động trên Kubernetes hoặc cloud network.

Ví dụ E2E trong `examples/udp-auto-discovery` dùng compatibility API của
`@livequery/core`, chạy gateway/service ở process riêng và kiểm tra cả hai thứ tự
khởi động. Pipeline `ServiceManifest` chuẩn vẫn dùng HTTP, file hoặc CI/CD.

### 5.2 FileServicePublisher

Dùng khi service và manifest agent nhìn thấy cùng filesystem:

```text
Service -> generic manifest file -> Agent -> Kong/Nginx controller
```

Mỗi instance ghi một file riêng:

```text
/var/run/livequery/services/
  users-pod-a.json
  users-pod-b.json
  orders-pod-a.json
```

File phải được ghi atomic:

```text
write users-pod-a.json.tmp -> fsync -> rename users-pod-a.json
```

Agent dùng `updatedAt` và TTL để phát hiện file stale. Trên Docker có thể dùng
shared volume. Trên Kubernetes chỉ dùng mô hình file khi agent là sidecar hoặc có
volume được chia sẻ rõ ràng; không coi filesystem của các Pod là filesystem chung.

File luôn chứa manifest trung lập, không chứa `kong.yaml` hoặc `nginx.conf`.

### 5.3 HttpServicePublisher

Dùng khi service và registry không cùng host. Endpoint đăng ký phải authenticated,
idempotent và giới hạn quyền theo `serviceId`. Registry lưu desired/current state và
phát event cho controller.

### 5.4 NoopServicePublisher

Dùng khi manifest đã được CI/CD thu thập và triển khai. Service vẫn có thể dùng
cùng code nhưng không thực hiện runtime registration.

## 6. Gateway controllers

### 6.1 Livequery Gateway

```text
@ohayo/udp
        |
ApiGatewayHandler
```

Gateway duy trì route table và có thể round-robin giữa các instance cùng
`serviceId`. Đây là mode thuận tiện nhất cho local và pure Linux.

### 6.2 Kong

```text
Manifest Registry -> KongGatewayController -> Kong desired state
```

Controller có thể dùng declarative configuration hoặc Admin API tùy cách vận hành,
nhưng phải reconcile idempotently:

- Tạo service/route còn thiếu.
- Cập nhật route đã thay đổi.
- Xóa resource được controller quản lý khi manifest hết hiệu lực.
- Gắn ownership/tag để không xóa cấu hình do người khác quản lý.
- Không cấp Kong admin credential cho application service.

### 6.3 Nginx

```text
Manifest Registry -> NginxGatewayController
                  -> render temporary config
                  -> nginx -t
                  -> atomic replace
                  -> graceful reload
```

Controller phải debounce event trong một khoảng ngắn và không reload Nginx theo
mỗi heartbeat. Nếu endpoint là Kubernetes Service hoặc DNS ổn định, thay đổi Pod
không được tạo ra một lần reload mới.

### 6.4 Kubernetes

Gateway controller hoặc CI sinh `HTTPRoute`/Ingress trỏ đến Kubernetes Service:

```text
/livequery/users/* -> users:3000
/livequery/orders/* -> orders:3000
```

Không đăng ký từng Pod vào gateway trừ khi có lý do đặc biệt. Readiness, endpoint
rotation và load balancing giữa Pod thuộc trách nhiệm của Kubernetes Service.

## 7. Cloudflare

Cloudflare Workers không có mô hình local shared file hoặc UDP discovery như một
Linux process thông thường. Vì vậy không dùng `@ohayo/udp` hoặc
`FileServicePublisher` bên trong Worker.

### 7.1 HTTP API

Một Worker stateless làm public entrypoint:

```text
Client
  |
Cloudflare Worker (auth, routing, headers, rate policy)
  |
  +-- Service Binding/RPC -> Worker service
  +-- fetch() ------------> public/private origin
  `-- Durable Object -----> stateful coordination only
```

Khi cả gateway và service đều là Workers trong cùng account, ưu tiên Service
Bindings/RPC thay vì gọi URL public. Binding vừa là capability vừa là internal API;
service discovery trở thành deploy-time binding configuration.

Manifest vẫn là source of truth. `CloudflareController` chuyển manifest thành:

- Worker service bindings.
- Route table/variables được deploy cùng Worker.
- Origin mapping khi backend nằm ngoài Workers.

Nếu backend ở ngoài Cloudflare, Worker proxy qua HTTP đến origin được khai báo rõ
ràng. Không cho request tự quyết định hostname upstream.

### 7.2 WebSocket trên Cloudflare

Plain Worker phù hợp với stateless routing nhưng không phải nơi giữ global
subscription state. Durable Objects phù hợp cho WebSocket vì có identity ổn định,
state và cơ chế Hibernation WebSocket API.

```text
Client
  |
Worker front door
  | validate upgrade token
  | choose deterministic shard
  v
Realtime Durable Object
  +-- WebSocket connections
  +-- subscription metadata
  `-- delivery for its shard
```

Không dùng một Durable Object tên `global` cho toàn bộ Livequery. Shard theo atom
phối hợp tự nhiên:

- `tenant:<tenantId>` khi tenant có quy mô giới hạn.
- `room:<roomId>` cho chat/collaboration.
- `document:<documentId>` cho collaborative document.
- `realtime:<tenantId>:<bucket>` khi cần hash-bucket nhiều kết nối.

Khóa shard phải deterministic để Worker route cùng một nhóm client đến cùng DO.
Nếu một event cần fan-out đến nhiều bucket, realtime router phải biết danh sách
bucket liên quan; không tạo một global DO chỉ để tránh bài toán routing này.

Durable Object nên dùng Hibernation WebSocket API. Metadata cần để phục hồi một
connection sau hibernation, như user, tenant và authorized refs, phải được lưu bằng
WebSocket attachment hoặc durable storage. Không dựa vào class property vì memory
có thể bị reset khi DO hibernate hoặc được thay instance.

Không dùng `setInterval` chỉ để ping client vì timer có thể ngăn hibernation. Tận
dụng protocol ping/pong của runtime và batch nhiều logical change trong một frame
khi tần suất event cao.

### 7.3 Đẩy realtime event đến Durable Objects

Khi producer cũng là Worker:

```text
Service Worker -> Service Binding/RPC -> Realtime Router -> DO stub
```

Khi producer nằm ngoài Cloudflare:

```text
Service -> signed HTTPS event endpoint -> Realtime Router -> DO stub
```

Event endpoint phải kiểm tra audience, service identity, timestamp, nonce/idempotency
key và authorization đối với ref. Có thể đặt queue giữa producer và router nếu cần
retry/buffering; consumer cuối vẫn route event đến DO shard sở hữu kết nối.

## 8. HTTP API Gateway và WebSocket Gateway

### 8.1 Quyết định

Trong production, hai gateway nên là **hai deployment độc lập**, nhưng có thể xuất
hiện dưới cùng domain và cùng external front door:

```text
api.example.com
  |
Nginx/Kong/Cloudflare/Kubernetes Gateway
  |
  +-- /livequery/* ----------------> HTTP API Gateway deployment
  `-- /livequery/realtime-updates -> WebSocket Gateway deployment
```

Lý do tách deployment:

| HTTP API Gateway | WebSocket Gateway |
| --- | --- |
| Stateless request/response | Giữ connection và subscription state |
| Scale theo RPS/latency | Scale theo connection, message rate và memory |
| Request tồn tại ngắn | Connection tồn tại lâu |
| Rollout tương đối đơn giản | Cần drain/reconnect khi rollout |
| Timeout theo request | Backpressure và slow-client handling |

Hai thành phần vẫn dùng chung:

- Protocol types.
- Auth verifier/internal identity.
- Route/ref normalization.
- Observability conventions.
- Broker event envelope.

Không nên chia sẻ bắt buộc cùng process memory.

### 8.2 Khi nào có thể chạy chung

Cho phép `embedded mode` chạy chung process/container khi:

- Local development.
- Một máy pure Linux nhỏ.
- Lưu lượng thấp và chấp nhận restart chung.
- Muốn một binary đơn giản để bắt đầu.

Code vẫn phải tạo hai component riêng để có thể tách mà không sửa nghiệp vụ:

```ts
const apiGateway = createApiGateway(...)
const realtimeGateway = createRealtimeGateway(...)

const server = createCombinedServer({ apiGateway, realtimeGateway })
```

Production có thể sử dụng cùng factory nhưng deploy riêng:

```ts
createApiGatewayServer(...)
createRealtimeGatewayServer(...)
```

### 8.3 Cloudflare là trường hợp đặc biệt

Cloudflare có thể dùng một Worker làm entrypoint chung cho cả HTTP route và
WebSocket upgrade. Tuy nhiên state WebSocket vẫn nằm trong Durable Objects. Do đó
bên ngoài trông như một gateway, nhưng bên trong vẫn tách:

```text
Single public Worker
  +-- HTTP API -> stateless handler/service binding
  `-- WebSocket -> sharded Durable Objects
```

Đây là mô hình được khuyến nghị cho Cloudflare: chung public edge, tách state và
scaling boundary.

## 9. Realtime event backbone ngoài Cloudflare

Khi WebSocket Gateway chạy nhiều replica, service không gửi event trực tiếp đến
một replica cụ thể. Service publish vào broker:

```text
Application service
       |
       | LivequeryChangeEvent
       v
NATS / Redis Streams / Kafka
       |
       +--> Realtime Gateway A -> clients connected to A
       `--> Realtime Gateway B -> clients connected to B
```

NATS phù hợp làm mặc định nhẹ cho Livequery. Event envelope phải độc lập transport:

```ts
type LivequeryChangeEvent = {
  eventId: string
  serviceId: string
  tenantId?: string
  ref: string
  type: 'added' | 'modified' | 'removed'
  data: { id: string; [key: string]: unknown }
  occurredAt: number
}
```

Gateway phải có bounded queue, batching, slow-client policy và idempotency/dedup
khi broker có thể redeliver.

## 10. Authentication và subscription authorization

WebSocket client không được tự gửi một `subscribe` tùy ý rồi vượt qua HTTP auth.
Có hai mô hình hợp lệ:

1. HTTP request đã authorize ref và gateway tạo subscription nội bộ cho đúng
   `clientId`.
2. Auth service phát subscription token ngắn hạn, ký số, ràng buộc user, tenant,
   ref, audience và expiry; WebSocket Gateway xác minh token trước khi subscribe.

Gateway phải xóa và tự ghi đè các header nội bộ:

```text
x-livequery-client-id
x-livequery-gateway-id
x-livequery-user-id
x-livequery-service-id
x-request-id
```

Service vẫn chịu trách nhiệm authorization nghiệp vụ. Gateway authentication không
thay thế kiểm tra quyền trên resource.

## 11. CI/CD và desired state

```text
Service CI
  +-- unit/integration tests
  +-- build image once
  +-- emit OpenAPI
  `-- emit ServiceManifest
                |
Gateway config pipeline
  +-- schema validation
  +-- route conflict validation
  +-- ownership/policy validation
  +-- render target configuration
  `-- commit environment repository
                |
             Argo CD
```

OpenAPI dùng cho contract/documentation/client generation. `ServiceManifest` bổ
sung deployment metadata và upstream ownership mà OpenAPI không mô tả đầy đủ.

## 12. Package boundary đã triển khai

```text
@livequery/protocol
  Runtime-neutral request, response, route and realtime event contracts.

@livequery/service
  ServiceManifest, ApiServiceLinker and publisher interfaces.

@livequery/discovery
  Runtime-neutral Discovery envelope and transport interface.

@livequery/discovery-http
  HttpDiscovery and HttpServicePublisher.

@livequery/discovery-file
  Atomic FileServicePublisher. Agent-side watcher is a later package concern.

@livequery/gateway
  Reference HTTP API Gateway implementation.

@livequery/realtime
  Runtime-neutral realtime protocol and broker interfaces.

@livequery/realtime-node
@livequery/realtime-bun
@livequery/realtime-cloudflare
  Runtime-specific WebSocket implementations.

@livequery/gateway-controller-kong
@livequery/gateway-controller-nginx
@livequery/gateway-controller-cloudflare
  Desired-state renderers for CI/CD or an external reconciliation agent.
```

Các package nằm trong `packages/` và được build theo dependency graph bằng Bun
workspace. `@livequery/core` hiện là compatibility facade: các consumer cũ vẫn
có thể nâng cấp theo từng bước, còn code mới phải import trực tiếp package nhỏ
nhất cần dùng.

UDP transport chỉ có một implementation trong `@ohayo/udp`. Livequery không có
package `discovery-udp`; compatibility export đi theo một chiều `@ohayo/udp` →
`@livequery/core` → `@livequery/bunjs`. Cách tích hợp và E2E nằm trong
`examples/udp-auto-discovery`.

`@livequery/gateway` chỉ dùng Fetch API và không mở server, không tự tạo discovery
transport, không import WebSocket implementation. `@livequery/realtime-*` sở hữu
runtime WebSocket. Các controller chỉ render desired state; việc apply, validate
ngoài môi trường và rollback thuộc CI/CD hoặc agent.

Framework adapters như Hono/NestJS chỉ phụ thuộc protocol/service contracts và
không phụ thuộc cứng vào Bun gateway implementation.

## 13. Deployment matrix

| Environment | Service publisher | HTTP gateway | WebSocket | Khuyến nghị |
| --- | --- | --- | --- | --- |
| Local process | UDP hoặc file | Embedded Livequery | Embedded | Chạy chung cho đơn giản |
| Docker Compose | UDP/file/static | Livequery/Nginx/Kong | Chung hoặc riêng | Cùng domain |
| Pure Linux | Signed UDP | Livequery Gateway | Tách khi tải tăng | Systemd + private network |
| Kubernetes | Noop/CI manifest | Kong/Nginx/Gateway API | Deployment riêng | Upstream là K8s Service |
| Cloudflare | Deploy-time bindings | Stateless Worker | Sharded Durable Objects | Chung front door, tách state |

## 14. Quyết định tóm tắt

- Giữ `ApiServiceLinker` làm API chung.
- Đổi các linker theo vendor thành generic publishers và vendor controllers.
- Gateway của repository cung cấp sẵn `UdpGatewayDiscovery`.
- Kong/Nginx không cần UDP gateway component; chúng dùng controller/agent.
- Cloudflare không dùng UDP/file runtime discovery; dùng manifest tại deploy time,
  bindings và Durable Objects.
- HTTP và WebSocket có thể chạy chung ở local, nhưng production mặc định tách
  deployment và dùng chung public front door.

## 15. Tham khảo Cloudflare

- [Workers Service Bindings/RPC](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/)
- [Durable Objects WebSockets and Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Rules and sharding of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
