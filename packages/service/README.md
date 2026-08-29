# @livequery/service

Định nghĩa `ServiceManifest`, `ServicePublisher` và lifecycle publisher phía
application service. Đây là API ổn định mà business service sử dụng bất kể hệ
thống chạy sau Livequery Gateway, Nginx, Kong, Kubernetes hay Cloudflare.

## Cài đặt

```sh
bun add @livequery/service
```

## Endpoint

Manifest hỗ trợ hai loại endpoint:

```ts
{ protocol: 'http', host: 'orders', port: 3000 }
{ kind: 'binding', binding: 'ORDERS_SERVICE' }
```

Network endpoint dùng cho Linux, container và Kubernetes Service. Binding
endpoint dùng ở control plane, ví dụ Cloudflare Service Bindings.

## ApiServiceLinker

```ts
import { ApiServiceLinker, NoopServicePublisher } from '@livequery/service'

const linker = new ApiServiceLinker({
  publisher: new NoopServicePublisher(),
  manifest: {
    schemaVersion: 1,
    serviceId: 'orders',
    version: '1.2.0',
    protocolVersion: '1',
    endpoint: { protocol: 'http', host: 'orders', port: 3000 },
    routes: [
      { id: 'orders-list', method: 'GET', path: '/orders', auth: 'required' },
    ],
  },
})

await linker.start()
await linker.ready()
await linker.draining()
await linker.close()
```

Mỗi lần publish sẽ tăng `seq`, cập nhật `updatedAt` và chuẩn hóa HTTP method.
`close()` idempotent và phát trạng thái `offline` trước khi đóng publisher.

## Chọn publisher

- HTTP registry: `@livequery/discovery-http`.
- UDP development discovery: dùng trực tiếp `@ohayo/udp`, xem
  `examples/udp-auto-discovery`; không có Livequery publisher package riêng.
- Shared filesystem: `@livequery/discovery-file`.
- CI/CD-only: `NoopServicePublisher`.

Package này không import gateway implementation hoặc concrete WebSocket class.
