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
| [`@livequery/discovery`](packages/discovery/README.md) | Node/Bun: gateway tự nhận biết service qua UDP (`@simple-discovery/udp`) |

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

## Livequery không kèm auth

Livequery là framework query + realtime, **không phải BaaS**. Nó không có, và không có kế hoạch có:

| | Livequery | Firebase / Supabase |
| --- | --- | --- |
| User store, đăng ký, đặt lại mật khẩu, MFA | không | có |
| OAuth provider, phiên, refresh token | không | có |
| Rules engine khai báo | không | Firestore Rules / Postgres RLS |
| Storage, functions, cron, email | không | có |
| SDK iOS / Android / Flutter | không | có |

Anh mang auth của mình tới. Livequery chỉ cần một thứ: một **principal** — chuỗi định danh người
gọi — được xác định trước khi request chạm vào route Livequery. Nó đến từ đâu là việc của anh:
Auth0, Clerk, Lucia, Supabase Auth, hay một bearer token tự ký.

```ts
app.use('/livequery/*', async (c, next) => {
  const principal = await verify(c.req.header('Authorization'))   // của anh
  if (!principal) return c.json({ error: { code: 'UNAUTHORIZED', message: '...' } }, 401)
  c.set('principal', principal)
  await next()
})
```

Trình duyệt không đặt được header trên một WebSocket upgrade, nên đường realtime phải nhận token
qua query string. `examples/cf-worker/src/authenticate.ts` xử lý cả hai đường.

## Phân quyền

Schema của `validator()` quyết định client **chạm được cột nào**. Nó không quyết định client chạm
được **dòng nào** — đó là việc của guard đứng trước chuỗi middleware. Có hai cách viết, cả hai đều
có trong [`examples/cf-worker/src/requireAuth.ts`](examples/cf-worker/src/requireAuth.ts).

**1. Scope theo path.** Đặt chủ sở hữu thành một đoạn path, rồi khẳng định nó là principal:

```ts
app.get('/livequery/users/:owner/tasks', requireSelf('owner'), validator(Task), livequery(), d1(), realtime(shards))
```

Route key thành `WHERE owner = ?` trong mọi truy vấn datasource dựng, và được ghi vào row khi
insert. Một lần kiểm tra phủ cả list, read, create, update, delete — và phủ luôn realtime, vì ref
là `users/<owner>/tasks`, nên một subscription không thể mang về dòng chưa qua guard này.

> Cột dùng làm route key phải **nằm ngoài** schema ghi. Đây không phải lời khuyên cho chắc — nó là
> chỗ duy nhất chặn. Body đã qua validator thì ghi đè được route key cùng tên khi insert, nên một
> schema khai báo `owner` đồng nghĩa với "client được tự đặt `owner`", và guard ở trên không kiểm
> tra lại. Để cột đó ngoài schema thì path là nguồn duy nhất sinh ra giá trị.

**2. Tra cứu trước khi cho qua.** Khi luật không rút về được một đoạn path — "chỉ sửa khi còn là
draft", "đọc được nếu `members` chứa tôi" — guard phải đọc dữ liệu rồi mới quyết định:

```ts
app.patch('/livequery/tasks/:id', requireOwnedTask(), validator(Task), livequery(), d1(), realtime(shards))
```

Tốn thêm một lần đọc mỗi request, và **chỉ áp dụng cho document**: một collection read không có
"dòng" nào để kiểm tra. Collection thì dùng cách 1.

Đây là chỗ Livequery yếu hơn Firestore Rules và Postgres RLS một cách thành thật: luật là code
mệnh lệnh anh tự viết, không phải policy khai báo, và **không có emulator nào canh anh viết sai**.
Đổi lại, luật chạy ở đúng một nơi đọc được từ trên xuống, và không có ngôn ngữ thứ hai phải học.

## Reconnect, và những gì bị mất

- **Rớt ngắn (trong `disconnectGraceMs`, mặc định 5s).** Gateway giữ subscription của client theo
  `client_id` **và giữ các thay đổi xảy ra trong lúc đó** (tối đa 1000 mỗi client), rồi gửi bù đúng
  thứ tự, ngay sau `hello`, một lần.
- **Server chưa biết socket cũ đã chết** (TCP nửa mở sau proxy, điện thoại đổi mạng): kết nối mới
  cùng `client_id` **thay** kết nối cũ, subscription chuyển theo.
- **Rớt lâu hơn, hoặc tải lại trang.** Client tự đọc lại khi nối lại: collection `server-first` /
  `cache-first` đọc lại trang đầu; scope local-first đọc **delta** — mọi thay đổi có `updated_at`
  mới hơn bản máy đang giữ, kèm tombstone.
- **Delta không bỏ sót.** Với `mongodb({ sync: true })` phiên bản được cấp theo **thứ tự commit**
  (`withVersion`), nên cả lần ghi commit chậm cũng không lọt. Client đọc chồng `syncOverlap`
  (mặc định 10s) cho các server không có bảo đảm đó.
- **Backoff nối lại** 2s, 4s, 8s… (tối đa 30s), reset khi kết nối mở được. Frame gửi lúc mất
  kết nối được xếp hàng và gửi một lần khi mở lại; frame của kết nối cũ không bao giờ phát lại.

Còn hở: bộ đệm thay đổi của gateway nằm trong bộ nhớ — gateway khởi động lại, hay một Durable
Object bị evict, thì mất; client vẫn đọc lại khi nối lại.

## Ghi đồng thời

Một lần sửa xếp hàng (local-first) mang theo phiên bản nó dựa vào (`If-Match`). Route
`sync: true` chỉ ghi nếu tài liệu vẫn ở phiên bản đó; có ai ghi trước thì trả **409
`VERSION_CONFLICT`**, client đọc bản trên server, cho qua `conflictResolver` (mặc định: giữ các
trường thiết bị này đã sửa) rồi gửi lại trên phiên bản mới — không ghi đè mà không ai biết.

## Đổi dữ liệu hoặc schema khi máy đã giữ bản sao

Máy chỉ hỏi "đã đổi gì từ phiên bản X", nên:

1. **Mọi lần ghi vào collection `sync` phải qua phiên bản** — route đã làm; script, migration, cron
   phải dùng `withVersion` (xem `packages/mongodb/README.md`). Ghi thẳng không tăng phiên bản thì
   máy đã đồng bộ giữ dạng cũ mãi mãi. Xoá cũng vậy: xoá mềm qua `withVersion`, không `deleteMany`.
2. **Đổi dạng theo kiểu thêm trước, bỏ sau:** thêm trường mới (không bắt buộc), phát hành app ghi
   trường đó, chỉ bỏ trường cũ khi không còn app cũ. Lần ghi offline từ app cũ gặp 400 thì nằm lại
   trên máy, đánh dấu lỗi, chờ người dùng gửi lại hoặc xoá.
3. **Đổi tên trường trong validator là thay đổi phá vỡ** — làm thành hai bước như trên.

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
