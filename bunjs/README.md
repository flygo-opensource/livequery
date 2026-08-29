# @livequery/bunjs

Adapter backend dành riêng cho Bun của Livequery.

Package này triển khai transport runtime; protocol và các type dùng chung được
lấy từ `@livequery/core`.

Nó hiện chứa:

- `WebsocketGatewayBase`: quản lý subscription, đồng bộ `sync` và kết nối
  gateway-to-gateway.
- `BunWebsocketGateway`: adapter `Bun.serve()` cho gateway base.
- `HttpDiscovery`: đăng ký và khám phá service qua Ohayo HTTP.
- `UdpDiscovery`: compatibility re-export từ `@livequery/core`, cuối cùng dùng
  implementation của `@ohayo/udp`; package Bun không có UDP implementation riêng.
- `ApiGatewayHandler`: route và proxy Livequery API tới service đã được khám phá.
- `ApiServiceLinker`: công bố metadata và endpoint của service.

```ts
import { BunWebsocketGateway } from '@livequery/bunjs'

const gateway = new BunWebsocketGateway({ port: 15535 })
```

Khi ứng dụng đã có `Bun.serve`, dùng `attachBunUpgrade()` và
`getBunWebsocketHandlers()` để dùng chung server.
