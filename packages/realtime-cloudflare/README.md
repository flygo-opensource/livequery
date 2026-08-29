# @livequery/realtime-cloudflare

Các primitive để public Cloudflare Worker chuyển WebSocket upgrade đến Durable
Objects và để Durable Object chấp nhận WebSocket bằng `WebSocketPair`.

## Cài đặt

```sh
bun add @livequery/realtime-cloudflare @livequery/realtime
```

## Public Worker: shard connection

```ts
import { CloudflareRealtimeRouter } from '@livequery/realtime-cloudflare'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const router = new CloudflareRealtimeRouter(env.REALTIME, {
      shardKey: request => {
        const url = new URL(request.url)
        return `${url.searchParams.get('tenant')}:${url.searchParams.get('room')}`
      },
    })
    return router.fetch(request)
  },
}
```

`shardKey` phải trả về tenant, room, document hoặc bounded bucket. Không dùng một
global Durable Object cho toàn bộ hệ thống. Router từ chối non-WebSocket request,
empty shard và shard dài hơn 256 ký tự.

## Durable Object socket adapter

```ts
import { EdgeWebsocketGateway } from '@livequery/realtime-cloudflare'

export class RealtimeRoom {
  readonly gateway = new EdgeWebsocketGateway()

  fetch(request: Request): Response {
    return this.gateway.handleRequest(request)
  }
}
```

`EdgeWebsocketGateway` phải được khởi tạo trong Durable Object, không được tạo
mới cho từng request ở public Worker.

## Giới hạn hiện tại

Subscription registry hiện nằm trong memory của Durable Object instance. Package
chưa tuyên bố hỗ trợ WebSocket Hibernation API. Một implementation hibernating
phải lưu socket attachment/subscription metadata và reconstruct registry khi
object được đánh thức.

Service-to-service HTTP trên Cloudflare nên dùng Service Bindings; UDP và file
watcher không chạy trong Worker runtime.
