# Livequery

Livequery cung cấp REST query và realtime cho cùng một nguồn dữ liệu. Phần lõi nằm
trong một package, `@livequery/core`, chia theo entry point cho từng runtime.

## Package

| Package | Trách nhiệm |
| --- | --- |
| [`@livequery/core`](packages/core/README.md) | Contract, parser, realtime protocol và adapter cho Node, Bun, Cloudflare |
| [`@livequery/d1`](packages/d1/README.md) | Datasource Cloudflare D1 |
| [`@livequery/mongodb`](packages/mongodb/README.md), [`@livequery/postgres`](packages/postgres/README.md) | Datasource MongoDB, PostgreSQL |
| [`@livequery/honojs`](packages/honojs/README.md), [`@livequery/nestjs`](packages/nestjs/README.md) | Adapter cho Hono và NestJS |
| [`@livequery/client`](packages/client/README.md), [`@livequery/rest`](packages/rest/README.md) | Client phía trình duyệt: collection, cache, transport REST + WebSocket |
| [`@livequery/react`](packages/react/README.md) | Hook React trên `@livequery/client` |
| [`@livequery/rpc`](packages/rpc/README.md) | RPC giữa các worker/service |

## Cấu trúc repo

```text
packages/    10 package phát hành lên npm, mỗi thư mục giữ nguyên lịch sử từ repo cũ
examples/    api-gateway, todo-mongodb, todo-app (React), cf-worker, cloudflare-multi-worker
tests/       e2e xuyên package, chạy với MongoDB thật
scripts/     build và test mọi package theo thứ tự phụ thuộc
```

Một workspace Bun, một lockfile. Các package tham chiếu nhau bằng version (`^3.0.0`), workspace tự
nối vào bản local, nên `package.json` của từng package vẫn đúng khi publish.

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
- [examples/todo-mongodb](examples/todo-mongodb/README.md): ứng dụng todo một process, kèm trang
  web nhỏ. Realtime đến từ change stream của MongoDB, nên một lần ghi từ mongosh cũng tới được
  client — `realtime()` vì thế chỉ đứng trên route GET.

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

- [`examples/cf-worker`](examples/cf-worker/README.md): một Worker có D1, auth, realtime sharding.
- [`examples/cloudflare-multi-worker`](examples/cloudflare-multi-worker/README.md):
  gateway và service tách thành nhiều Worker.

## Build và test

```sh
bun install
bun run build
bun run test          # unit test của mọi package + e2e example không cần database
```

Test e2e với MongoDB cần một replica set (change stream không có trên mongod đơn lẻ):

```sh
LIVEQUERY_E2E_MONGO_URL='mongodb://user:pass@host:27017' bun test tests/
```
