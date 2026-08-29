# @livequery/gateway

HTTP gateway engine thuần Fetch API. Package nhận `Request`, chọn một ready
service instance và trả `Response`; nó không mở port, không tự tạo discovery
transport và không import WebSocket implementation.

## Cài đặt

```sh
bun add @livequery/gateway @livequery/service
```

## Gateway nhúng trong Bun

```ts
import { ApiGatewayHandler } from '@livequery/gateway'

const gateway = new ApiGatewayHandler({ timeoutMs: 30_000 })
gateway.applyManifest(serviceManifest)

Bun.serve({
  port: 8080,
  fetch: request => gateway.fetch(request),
})
```

## Discovery bridge

```ts
import { ApiGatewayHandler, DiscoveryGatewayRegistry } from '@livequery/gateway'

const gateway = new ApiGatewayHandler()
const registry = new DiscoveryGatewayRegistry(discovery, gateway)

// Shutdown
registry.close()
gateway.close()
```

## Routing behavior

- Chỉ route manifest có trạng thái `ready`.
- Round-robin giữa các replica cùng `serviceId`.
- Thử instance tiếp theo khi xảy ra network failure.
- Static route được ưu tiên hơn prefix-param và wildcard-param.
- `:id` và `:userId` được normalize giống nhau khi kiểm tra ownership.
- Hai service khác nhau sở hữu cùng method/path sẽ phát sinh
  `RouteConflictError`.
- Xóa các internal identity header do client gửi trước khi forward.

`prepareHeaders` cho phép gateway authentication layer ghi các header nội bộ đã
xác minh. Package không thay thế authorization nghiệp vụ trong service.

Network gateway không nhận endpoint `{ kind: 'binding' }`; loại endpoint đó phải
được xử lý bởi Cloudflare control plane.
