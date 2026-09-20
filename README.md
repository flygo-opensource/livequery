# Livequery workspace

Livequery cung cấp REST query và realtime cho cùng một nguồn dữ liệu. Phần lõi nằm
trong một package, `@livequery/core`, chia theo entry point cho từng runtime.

## Package

| Package | Trách nhiệm |
| --- | --- |
| [`@livequery/core`](core/README.md) | Contract, parser, realtime protocol và adapter cho Node, Bun, Cloudflare |
| [`@livequery/d1`](d1/README.md) | Datasource Cloudflare D1 |
| `@livequery/mongodb`, `@livequery/postgres` | Datasource MongoDB, PostgreSQL |
| `@livequery/nestjs`, `@livequery/honojs` | Adapter cho NestJS và Hono |

Danh sách class và symbol: [PACKAGE_API.md](PACKAGE_API.md).
Quy chuẩn viết TypeScript: [CODE_STYLE.md](CODE_STYLE.md).

## Entry point của core

| Entry | Dùng khi |
| --- | --- |
| `@livequery/core` | Chỉ cần contract, parser, protocol. Chạy mọi runtime |
| `@livequery/core/node` | Server Node: realtime gateway trên `ws`, helper http ↔ Fetch |
| `@livequery/core/bun` | Server Bun: realtime gateway trên `Bun.serve` |
| `@livequery/core/workers` | Cloudflare Worker và Durable Object |

`ws` là optional peer dependency, chỉ cần cho `/node`. Worker không import `/node` hay `/bun`.

## Node.js và Bun

Service là một app Hono; gateway định tuyến tới nó theo tiền tố path và giữ WebSocket của client.
Cùng một file chạy trên cả hai runtime, vì `serve()` và `realtimeGateway()` đến từ bản build của
runtime đang chạy.

```ts
// service
app.get('/livequery/tasks', validator(Task), livequery(), d1(), realtime())

// gateway
app.use('*', gateway({ routing, realtime: await realtimeGateway() }))
export default serve(app, { port: 8080, realtime })
```

- [examples/api-gateway](examples/api-gateway/README.md): gateway và service API hoàn chỉnh
  (CRUD + realtime). Cùng một file chạy trên cả Node lẫn Bun, có test e2e cho bốn tổ hợp runtime.

## Cloudflare

Không có discovery lúc chạy. Gateway Worker gọi service Worker qua Service Binding
khai báo trong `wrangler.jsonc`; realtime nằm trong Durable Object dùng
`HibernatableWebsocketGateway`.

```ts
import {
  CloudflareRealtimePublisher,
  CloudflareRealtimeRouter,
  HibernatableWebsocketGateway,
} from '@livequery/core/workers'
```

- [`cf-worker`](cf-worker/README.md): một Worker có D1, auth, realtime sharding.
- [`examples/cloudflare-multi-worker`](examples/cloudflare-multi-worker/README.md):
  gateway và service tách thành nhiều Worker.

## Build và test

```sh
bun install
bun run build
bun run test
```
