# @livequery/gateway-controller-nginx

Render Nginx upstream/location configuration từ validated `ServiceManifest`.
Output là desired state string; package không tự ghi `nginx.conf` hoặc reload
Nginx.

## Cài đặt

```sh
bun add @livequery/gateway-controller-nginx
```

## Sử dụng

```ts
import { renderNginxConfig } from '@livequery/gateway-controller-nginx'

const config = renderNginxConfig(manifests)
await writeDesiredConfig(config)
```

Renderer:

- Gom replica thành một Nginx `upstream`.
- Chuyển dynamic path segment thành regex location.
- Gom nhiều HTTP method cùng path vào một `limit_except`.
- Ghi `Host` và `X-Request-Id` proxy headers.
- Từ chối duplicate route ownership qua common topology validation.

## Apply an toàn

Agent/CI bên ngoài nên thực hiện theo thứ tự:

1. Ghi temporary config.
2. Chạy `nginx -t`.
3. Atomic replace file chính.
4. Graceful reload.
5. Rollback nếu health check thất bại.

`targetPath` hiện chưa được hỗ trợ và renderer sẽ throw thay vì sinh config sai.
