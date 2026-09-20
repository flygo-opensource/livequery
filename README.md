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
| `@livequery/core/node` | Server Node: gateway `ws`, discovery HTTP, API gateway |
| `@livequery/core/bun` | Server Bun: gateway `Bun.serve`, discovery HTTP, API gateway |
| `@livequery/core/udp` | Discovery UDP trong LAN (cần `@ohayo/udp`) |
| `@livequery/core/workers` | Cloudflare Worker và Durable Object |

`ws` và `@ohayo/udp` là optional peer dependency. Worker không import `/node`, `/bun` hay
`/udp`: các entry đó kéo `ws`, `http` hoặc `dgram` vào bundle.

## Node.js và Bun

Service tự công bố host, port và route qua discovery; gateway nghe discovery, proxy
HTTP và nối WebSocket tới realtime gateway của từng service.

```ts
import { ApiGatewayHandler, HttpDiscovery, WebsocketGateway } from '@livequery/core/node'
```

Trên Bun đổi đường import thành `@livequery/core/bun`; `WebsocketGateway` khi đó là
`BunWebsocketGateway`.

- [examples/api-gateway](examples/api-gateway/README.md): gateway và service API hoàn chỉnh
  (CRUD + realtime) cho Node và Bun, có test e2e cho cả bốn tổ hợp runtime.
- [examples/udp-auto-discovery](examples/udp-auto-discovery/README.md): discovery UDP trong LAN.

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
