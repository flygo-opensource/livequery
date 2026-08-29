# @livequery/gateway-controller-cloudflare

Render kế hoạch route và Service Binding cho Cloudflare Worker deployment.
Package chỉ tạo desired-state object; Wrangler/Terraform/CI chịu trách nhiệm apply.

## Cài đặt

```sh
bun add @livequery/gateway-controller-cloudflare
```

## Sử dụng

```ts
import { renderCloudflarePlan } from '@livequery/gateway-controller-cloudflare'

const plan = renderCloudflarePlan(manifests)
```

Với endpoint:

```ts
{ kind: 'binding', binding: 'BILLING_SERVICE' }
```

renderer giữ nguyên binding name. Với network endpoint, renderer sinh binding từ
`serviceId`, ví dụ `billing-api` thành `SERVICE_BILLING_API`; pipeline vẫn phải
map tên này tới Worker service thật.

Mỗi plan entry chứa `serviceId`, `binding` và danh sách route. Các replica cùng
service phải sinh ra plan giống nhau, nếu không renderer sẽ từ chối.

Package không xử lý WebSocket state. WebSocket front-door và Durable Object
sharding nằm trong `@livequery/realtime-cloudflare`.
