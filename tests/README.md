# @livequery/tests

Cross-package end-to-end tests for the livequery ecosystem — full stack, against a **real MongoDB**:

```
Frontend:  @livequery/client + rest (HTTP+WS) · react hooks · rpc (worker bridge)
Backend:   @livequery/honojs · @livequery/nestjs → @livequery/mongodb → MongoDB
Realtime:  ① self-emit (gateway.next / gateway.link)  ② MongodbRealtime (change streams)
```

## Layout requirement

This repo must be cloned as `tests/` **inside the livequery workspace folder**, next to its sibling package repos (tests import siblings by relative path):

```
livequery/
├── core/        # git@github.com:livequery/core.git       (built: bun run build)
├── client/      # git@github.com:livequery/client.git     (built: bun run build)
├── rest/
├── react/
├── rpc/
├── honojs/
├── nestjs/
├── mongodb/
└── tests/       # ← this repo
```

Each sibling package needs its own `bun install` (and `core` + `client` need a build).

## Running

```bash
# requires a MongoDB with change streams (replica set)
export LIVEQUERY_E2E_MONGO_URL='mongodb://127.0.0.1:27017'  # default
export LIVEQUERY_E2E_DB_NAME='livequery'                                      # default

cd tests
bun test --timeout 20000 .                       # full suite (or: bun run test)
bun test --timeout 20000 hono-mongodb-crud.e2e.test.ts   # single file
```

Always pass `--timeout 20000` (real Mongo over LAN + websockets exceed bun's 5s
default; bunfig's `[test] timeout` is not honoured by bun, so the flag is required).
`bun run test` already includes it.

`tsconfig.json` in this repo is REQUIRED: bun reads compiler flags from the cwd's
tsconfig, and without `experimentalDecorators` it silently drops NestJS `@Inject`
parameter decorators — DI then constructs interceptors with undefined deps.

## Suites

| File | Stack under test |
|---|---|
| `hono-mongodb-crud` | HTTP → Hono `useDatasource` → MongoDatasource: CRUD, filters, cursor/offset paging, summary |
| `hono-mongodb-realtime` | WS subscription qua middleware (x-lcid) + MongodbRealtime change streams → sync |
| `nestjs-mongodb-crud` | HTTP → NestJS LivequeryInterceptor → MongoDatasource: `{data}` envelope contract |
| `nestjs-datasource-mapper` | Full `createDatasourceMapper` pipeline (decorator → `LivequeryDatasourceInterceptors` → `MongoDatasource.handle()`), realtime qua `watcher: MongodbRealtime` — đường wiring production của @livequery/nestjs |
| `client-nestjs-fullstack` | LivequeryClient + RestTransporter + MemoryStorage → NestJS, realtime vào `collection.items` |
| `client-hono-fullstack` | Same matrix trên Hono (shared suite — chứng minh client adapter-agnostic) |
| `multi-client-sync` | 2 client độc lập: A mutate → B nhận realtime, unsubscribe isolation |
| `realtime-self-emit` | `gateway.next()` thủ công, `gateway.link()` pipe, doc-level subscription, unsubscribe |
| `realtime-nested-ref` | Fan-out `users/:userId/posts`, array membership added/removed với Mongo thật |
| `gateway-multinode` | 2 gateway bridge nhau: sync route xuyên node về client |
| `gateway-rotation` | Client WS@A, HTTP rotate qua 2 ApiGatewayHandler → service node: sub luôn trỏ đúng gateway của client (x-lgid), mutations qua proxy nhận realtime đúng 1 lần |
| `ws-reconnect` | WS rớt → reconnect trong grace window (5s) → realtime hồi phục không cần re-query; quá grace thì sub bị xoá; dead peer không chặn fan-out |
| `gateway-security` | WS subscribe-bypass (documented), không subscribe hộ client_id khác, realtime ẩn private field, gateway-to-gateway auth (sai token bị từ chối, đúng token relay được) |
| `malformed-requests` | Input lỗi trả 4xx (không 500): malformed cursor → 400 INVALID_CURSOR, bad oid → 400 INVALID_OBJECT_ID (ghi rõ field); limit clamp, doc-not-found 200 |
| `subscription-lifecycle` | subscribe/unsubscribe 100 lần, connect/disconnect 25 lần → không rò `_subscriptions`/`_connections`/`_pendingDisconnects`; ref sống tới subscriber cuối |
| `react-fullstack` | useCollection/useDocument/useObservable/useAction với backend thật (react-test-renderer) |
| `rpc-livequery-bridge` | Collection sống ở "worker", stream qua WorkerManager/ServiceLinker về UI |
| `rest-mongodb-nestjs-realtime` | REST client → NestJS → MongoDatasource + MongodbRealtime (legacy suite) |
| `rest-mongoose-nestjs-realtime` | REST client → NestJS → MongooseDatasource + change stream thủ công (legacy suite) |

Shared infra in `helpers/`: `servers.ts` (full Hono/NestJS app builders), `client-suite.ts` (shared client matrix), `realtime.ts` (change-stream warmup), `mongo.ts`, `ws.ts`, `wait.ts`.

See `E2E_PLAN.md` for the full test plan and remaining stretch items.
