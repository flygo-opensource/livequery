# @livequery/realtime-bun

Bun-native WebSocket adapter cho Livequery realtime. Có thể chạy standalone hoặc
gắn vào một `Bun.serve()` do application sở hữu.

## Cài đặt

```sh
bun add @livequery/realtime-bun @livequery/realtime
```

## Standalone

```ts
import { BunWebsocketGateway } from '@livequery/realtime-bun'

const gateway = new BunWebsocketGateway({
  port: 8081,
  path: '/livequery/realtime-updates',
})
```

## Dùng chung Bun server

```ts
const gateway = new BunWebsocketGateway()

Bun.serve({
  fetch(request, server) {
    if (gateway.attachBunUpgrade(request, server)) return
    return new Response('Not found', { status: 404 })
  },
  websocket: gateway.getBunWebsocketHandlers(),
})
```

`attachBunUpgrade` chỉ upgrade request khớp `gateway.path`. Socket data được đánh
dấu riêng để handler có thể chia sẻ server với WebSocket protocol khác.
