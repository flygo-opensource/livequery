# @livequery/gateway-controller-kong

Render Kong declarative configuration object từ `ServiceManifest`. Package không
gọi Kong Admin API và không thực hiện rollout.

## Cài đặt

```sh
bun add @livequery/gateway-controller-kong
```

## Sử dụng

```ts
import { renderKongConfig } from '@livequery/gateway-controller-kong'

const desired = renderKongConfig(manifests)
await saveJson('kong.generated.json', desired)
```

Output gồm:

- `_format_version: '3.0'`.
- Một Kong upstream cho mỗi logical service.
- Một target cho mỗi ready service instance.
- Kong service và routes với method/path tương ứng.

Trước khi apply, pipeline nên validate schema, so sánh diff với desired state cũ,
kiểm tra ownership/policy và lưu revision để rollback. Plugin auth, rate limit và
consumer configuration nên được quản lý ở policy layer riêng.
