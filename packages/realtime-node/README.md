# @livequery/realtime-node

Node.js adapter cho Livequery realtime, sử dụng package `ws` và gắn vào một
`http.Server` có sẵn.

## Cài đặt

```sh
npm install @livequery/realtime-node @livequery/realtime
```

## Sử dụng

```ts
import { createServer } from 'node:http'
import { WebsocketGateway } from '@livequery/realtime-node'

const server = createServer()
const gateway = new WebsocketGateway(server, {
  disconnectGraceMs: 5_000,
})

server.listen(8081)
```

Có thể tạo gateway trước và gắn server sau:

```ts
const gateway = new WebsocketGateway()
gateway.attach(server)
```

`close()` đóng WebSocket clients và tách adapter. Khi HTTP server đóng, adapter
cũng cleanup các gateway đã gắn vào server đó.

Package này chỉ chạy trên Node-compatible runtime và không được import trong
Cloudflare Worker bundle.
