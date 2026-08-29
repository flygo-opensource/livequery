# @livequery/gateway-controller

Xây dựng và validate logical service topology từ một tập `ServiceManifest` trước
khi render cấu hình theo vendor.

## Cài đặt

```sh
bun add @livequery/gateway-controller @livequery/service
```

## Sử dụng

```ts
import { createServiceTopology } from '@livequery/gateway-controller'

const topology = createServiceTopology(manifests)
```

Mỗi topology entry gồm:

```ts
type ServiceTopology = {
  serviceId: string
  protocol: 'http' | 'https'
  routes: ServiceRoute[]
  targets: Array<{ instanceId: string; host: string; port: number }>
}
```

## Validation

- Bỏ qua manifest không ở trạng thái `ready`.
- Collapse các replica cùng `serviceId` thành một logical service.
- Từ chối replica công bố protocol/routes khác nhau.
- Normalize tên path parameter khi kiểm tra route conflict.
- Từ chối endpoint `{ kind: 'binding' }` vì topology này dành cho network
  gateway. Cloudflare controller xử lý binding riêng.

Package không ghi file, gọi vendor API hoặc thay đổi external state.
