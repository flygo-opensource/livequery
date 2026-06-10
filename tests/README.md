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
bun test .                      # full suite
bun test hono-mongodb-crud.e2e.test.ts   # single file
```

`bunfig.toml` raises the per-test timeout to 20s (real Mongo over LAN + websockets).

## Suites

| File | Stack under test |
|---|---|
| `hono-mongodb-crud` | HTTP → Hono `useDatasource` → MongoDatasource: CRUD, filters, cursor/offset paging, summary |
| `hono-mongodb-realtime` | WS subscription qua middleware (x-lcid) + MongodbRealtime change streams → sync |
| `nestjs-mongodb-crud` | HTTP → NestJS LivequeryInterceptor → MongoDatasource: `{data}` envelope contract |
| `client-nestjs-fullstack` | LivequeryClient + RestTransporter + MemoryStorage → NestJS, realtime vào `collection.items` |
| `client-hono-fullstack` | Same matrix trên Hono (shared suite — chứng minh client adapter-agnostic) |
| `multi-client-sync` | 2 client độc lập: A mutate → B nhận realtime, unsubscribe isolation |
| `realtime-self-emit` | `gateway.next()` thủ công, `gateway.link()` pipe, doc-level subscription, unsubscribe |
| `realtime-nested-ref` | Fan-out `users/:userId/posts`, array membership added/removed với Mongo thật |
| `gateway-multinode` | 2 gateway bridge nhau: sync route xuyên node về client |
| `react-fullstack` | useCollection/useDocument/useObservable/useAction với backend thật (react-test-renderer) |
| `rpc-livequery-bridge` | Collection sống ở "worker", stream qua WorkerManager/ServiceLinker về UI |
| `rest-mongodb-nestjs-realtime` | REST client → NestJS → MongoDatasource + MongodbRealtime (legacy suite) |
| `rest-mongoose-nestjs-realtime` | REST client → NestJS → MongooseDatasource + change stream thủ công (legacy suite) |

Shared infra in `helpers/`: `servers.ts` (full Hono/NestJS app builders), `client-suite.ts` (shared client matrix), `realtime.ts` (change-stream warmup), `mongo.ts`, `ws.ts`, `wait.ts`.

See `E2E_PLAN.md` for the full test plan and remaining stretch items.
