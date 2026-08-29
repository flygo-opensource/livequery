# Livequery workspace

Repository workspace này tách contract, service publication, gateway và realtime
theo runtime boundary. Application service không phụ thuộc Nginx, Kong,
Kubernetes hoặc Cloudflare SDK.

## Package graph

```text
@livequery/protocol
       ^
       +-- @livequery/service <-- discovery-http / discovery-file
       +-- @livequery/gateway
       `-- @livequery/realtime <-- realtime-node / realtime-bun / realtime-cloudflare

ServiceManifest --> gateway-controller --> nginx / kong / cloudflare desired state
```

## Package catalog

Danh sách class/interface/function và ý nghĩa chi tiết: [PACKAGE_API.md](PACKAGE_API.md).

| Package | Trách nhiệm |
| --- | --- |
| [`@livequery/protocol`](packages/protocol/README.md) | Contract, parser, query và realtime event types |
| [`@livequery/service`](packages/service/README.md) | `ServiceManifest`, publisher interface và lifecycle linker |
| [`@livequery/discovery`](packages/discovery/README.md) | Ohayo discovery envelope và transport contract |
| [`@livequery/discovery-http`](packages/discovery-http/README.md) | HTTP registry, heartbeat và service publisher |
| [`@livequery/discovery-file`](packages/discovery-file/README.md) | Atomic JSON manifest publisher |
| [`@livequery/gateway`](packages/gateway/README.md) | Fetch API routing, load balancing và forwarding |
| [`@livequery/realtime`](packages/realtime/README.md) | Realtime protocol engine và broker contracts |
| [`@livequery/realtime-node`](packages/realtime-node/README.md) | Node `ws` runtime adapter |
| [`@livequery/realtime-bun`](packages/realtime-bun/README.md) | Bun-native WebSocket adapter |
| [`@livequery/realtime-cloudflare`](packages/realtime-cloudflare/README.md) | Worker-to-Durable-Object routing và edge socket adapter |
| [`@livequery/gateway-controller`](packages/gateway-controller/README.md) | Validate và collapse logical service topology |
| [`@livequery/gateway-controller-nginx`](packages/gateway-controller-nginx/README.md) | Render Nginx desired state |
| [`@livequery/gateway-controller-kong`](packages/gateway-controller-kong/README.md) | Render Kong declarative desired state |
| [`@livequery/gateway-controller-cloudflare`](packages/gateway-controller-cloudflare/README.md) | Render Cloudflare binding/route plan |

## Service registration

```ts
import { ApiServiceLinker } from '@livequery/service'
import { HttpServicePublisher } from '@livequery/discovery-http'

const linker = new ApiServiceLinker({
  manifest: {
    schemaVersion: 1,
    serviceId: 'orders',
    version: '1.0.0',
    protocolVersion: '1',
    endpoint: { protocol: 'http', host: '127.0.0.1', port: 3001 },
    routes: [
      { id: 'orders-list', method: 'GET', path: '/orders', auth: 'required' },
    ],
  },
  publisher: new HttpServicePublisher({
    namespace: 'development',
    tags: ['livequery', 'service'],
    key: process.env.OHAYO_DISCOVERY_KEY!,
    gateways: ['http://127.0.0.1:12001'],
  }),
})

await linker.start()
await linker.ready()

// SIGTERM: stop receiving work, then publish offline.
await linker.draining()
await linker.close()
```

## UDP auto-discovery examples

UDP development mode không có package wrapper riêng trong Livequery. Gateway và
service dùng trực tiếp `@ohayo/udp`; facade `@livequery/core` chỉ giữ re-export
tương thích cho code cũ.

Bộ [UDP E2E examples](examples/udp-auto-discovery/README.md) chạy gateway và
service ở các process riêng, kiểm tra cả hai thứ tự khởi động và không gọi
`gateway.register()` thủ công:

```sh
bun run --cwd examples test
```

Đổi sang file agent không làm thay đổi service manifest:

```ts
import { FileServicePublisher } from '@livequery/discovery-file'

const publisher = new FileServicePublisher({
  directory: '/var/run/livequery/services',
})
```

## Gateway engine

`@livequery/gateway` chỉ nhận và trả Web API `Request`/`Response`. Runtime bên
ngoài quyết định mở port bằng Bun, Node, Hono hoặc Cloudflare Worker.

```ts
import { ApiGatewayHandler } from '@livequery/gateway'

const gateway = new ApiGatewayHandler()
gateway.applyManifest(serviceManifest)

Bun.serve({ fetch: request => gateway.fetch(request) })
```

## Cloudflare realtime

`CloudflareRealtimeRouter` chạy trong public Worker và chuyển WebSocket upgrade
đến Durable Object theo shard. Không tạo một global Durable Object cho toàn hệ
thống.

```ts
import { CloudflareRealtimeRouter } from '@livequery/realtime-cloudflare'

const realtime = new CloudflareRealtimeRouter(env.REALTIME, {
  shardKey: request => new URL(request.url).searchParams.get('room') ?? '',
})
```

## Build và test

```sh
bun install
bun run build
bun run test
```

`@livequery/core` vẫn giữ facade tương thích cho code cũ. Code mới nên import
trực tiếp package nhỏ nhất cần dùng.
