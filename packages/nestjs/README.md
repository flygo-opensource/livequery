# @livequery/nestjs

NestJS adapter for the [livequery](https://github.com/livequery) ecosystem — turns plain NestJS controllers into livequery endpoints (filterable/paginated CRUD over HTTP) with optional realtime sync over WebSocket.

```
HTTP request ──▶ LivequeryInterceptor ──▶ LivequeryDatasourceInterceptors ──▶ datasource.handle(ctx)
                 (parse + WS subscribe)        (route metadata → engine)        (@livequery/mongodb, ...)
                                                                                        │
WS client ◀── WebsocketGateway ◀── watcher (e.g. MongodbRealtime change streams) ◀─────┘
```

Datasources implement the engine contract from `@livequery/core` (`LivequeryDatasource`: `init` + `handle`). `@livequery/mongodb` is the reference implementation.

## Install

```bash
bun add @livequery/nestjs @livequery/core
# peer deps (you likely have them already in a NestJS app):
bun add reflect-metadata @nestjs/core @nestjs/common @nestjs/platform-ws @nestjs/websockets express
# the reference datasource:
bun add @livequery/mongodb mongodb
```

## Quick start (MongoDB)

**1. Create the decorator + provider pair** with `createDatasourceMapper`:

```ts
// UseMongodbDatasource.ts
import { createDatasourceMapper } from '@livequery/nestjs'
import { MongoDatasource, MongodbRealtime, RouteOptions } from '@livequery/mongodb'
import type { Provider } from '@nestjs/common'

const [decorator, provider] = createDatasourceMapper({
    querier: MongoDatasource,          // class, constructed via NestJS DI
    watcher: MongodbRealtime,          // optional — change streams → realtime
    config: {
        connections: { default: mongoClient },
        databases: ['main'],
    },
})

export const MongodbDatasourceProvider: Provider = provider
export const UseMongodbDatasource = (options: RouteOptions) => decorator(options)
```

`config` can also be a factory `(...injections) => Config` resolved through DI — pass the inject tokens via `injects: [...]` (e.g. `getConnectionToken()` from `@nestjs/mongoose`).

**2. Decorate controller routes** (paths must start with `livequery/`):

```ts
@Controller('livequery/tasks')
export class TaskController {
    @Get()           @UseMongodbDatasource({ collection: 'tasks', realtime: true }) list() { }
    @Get(':id')      @UseMongodbDatasource({ collection: 'tasks' })                 get() { }
    @Post()          @UseMongodbDatasource({ collection: 'tasks' })                 create() { }
    @Patch(':id')    @UseMongodbDatasource({ collection: 'tasks' })                 update() { }
    @Delete(':id')   @UseMongodbDatasource({ collection: 'tasks' })                 remove() { }
}
```

Handlers can return nothing (the datasource result is returned as-is), a `LivequeryItemMapper` to transform items, or a function `(result) => response` for full control.

**3. Register everything in the module:**

```ts
import { DiscoveryModule } from '@nestjs/core'
import { WebsocketGateway } from '@livequery/core'

@Module({
    imports: [DiscoveryModule],                       // required by route discovery
    controllers: [TaskController],
    providers: [
        MongodbDatasourceProvider,
        { provide: WebsocketGateway, useValue: gateway },  // new WebsocketGateway(httpServer)
    ],
})
export class AppModule { }
```

On bootstrap the provider discovers every decorated route, calls `datasource.init(routes)`, and (if a `watcher` was given) pipes `watcher.watch(config, routes, ds)` into the gateway for realtime fan-out.

## Querying

All livequery query grammar flows through automatically:

```
GET /livequery/tasks?done:eq=false&seq:gte=10&seq:sort=desc&:limit=20&:after=<cursor>
```

Responses carry `items`/`item` plus paging (`count`, `has`, `cursor`, `page`). Underscore-prefixed fields (`_secret`, …) are stripped from `item`, `items`, and the `{ data }` envelope automatically.

Realtime: a client that sends `x-lcid`/`x-lgid` headers on a GET is subscribed on the gateway; subsequent changes (including out-of-band DB writes when using `MongodbRealtime`) are pushed as `sync` events. Use `@livequery/client` + `@livequery/rest` on the frontend.

## API surface

| Export | Purpose |
|---|---|
| `createDatasourceMapper({ querier, watcher?, injects?, config })` | Returns `[decorator, provider]` wiring a datasource class into routes + DI |
| `LivequeryInterceptor` / `UseLivequeryInterceptor()` | Parses the request into `req.livequery`, registers WS subscriptions, masks private fields |
| `LivequeryDatasourceInterceptors` | Resolves route metadata and drives `datasource.handle(ctx)` |
| `LivequeryItemMapper` | Per-item response mapping helper |
| `@LivequeryRequest()` | Param decorator exposing the parsed `LivequeryRequest` |
| `ApiGateway`, `ApiServiceLinker`, `listPaths` | Gateway/multi-node utilities |
| `WebsocketGateway`, `UdpDiscovery`, … | Re-exported from `@livequery/core` |
| `LivequeryDatasource`, `UpdatedData`, `QueryOption`, `FilterConditions`, `Paging`, … | Type surface re-exported from `@livequery/core` |

## Datasource & watcher contracts

```ts
// querier: class whose instances satisfy core's engine contract
type LivequeryDatasourceFactory<Config, RouteOptions> = {
    new (...args: any[]): LivequeryDatasource<RouteOptions> & { config?: Config }
}
// LivequeryDatasource<RouteOptions> (from @livequery/core):
//   init(routes: Array<RouteOptions & { method: string, path: string }>): Promise<void> | void
//   handle(ctx: LivequeryContext): any

// watcher: realtime source
type LivequeryDatasourceWatcher<Config, RouteOptions> = {
    watch(
        config: Config,
        routes: Array<{ path: string, schema: string, method: string, options: RouteOptions }>,
        ds: LivequeryDatasource<RouteOptions>,
    ): Observable<UpdatedData<any>>
}
```

`config` is assigned onto the instance by the provider after DI construction. Route `path`/`schema` are produced by `@livequery/core`'s `LivequeryRequestParser` from the controller route patterns (the `livequery/` prefix and the document-id segment are stripped — e.g. `livequery/users/:uid/posts/:id` → `users/:uid/posts`); `method` is the HTTP verb string (`'GET'`, `'POST'`, …).

## Notes

- **Transpilers**: the interceptors use explicit `@Inject(...)` tokens, so the package works under bundlers that don't emit `design:paramtypes` (bun, esbuild, vite). Your app still needs `experimentalDecorators` (standard for NestJS); when running TS sources directly with bun, make sure a `tsconfig.json` with `experimentalDecorators` is visible from your working directory, or parameter decorators are silently dropped.
- **Realtime** with `MongodbRealtime` requires MongoDB change streams (replica set / mongos) and, for full delete payloads, the `collMod` privilege (pre/post images).
- Errors thrown by datasources are structured `{ status, code, message }` objects — add an exception filter if you want them mapped onto HTTP responses.

## Breaking changes in 2.0.148

- Depends on `@livequery/core ^2.0.148` (peer); `@livequery/types` is no longer used or re-exported. The shared type surface now comes from core.
- `LivequeryDatasource` exported here is now core's single-generic type (`LivequeryDatasource<RouteOptions>`); the old local two-generic `Subject`-based type was removed. Datasources must implement core's `handle(ctx)` — `@livequery/mongodb` ≥ 2.0.148 and `@livequery/mongoose` already do.
- The interceptor drives datasources through `handle(ctx)` (engine entry point) instead of calling `query(req, options)` directly; route options are resolved from the datasource's own route table built at `init()`.
- Watcher route `method` is now the verb string (`'GET'`) instead of NestJS's `RequestMethod` enum number.
- Client-side types (`Transporter`, `Response`, `QueryStream`, `DocumentResponse`) are no longer re-exported — import them from the client packages if you need them.
- Removed `LivequeryWebsocketSync` (an empty placeholder class) and `SimpleApiGateway` (a thin `@Injectable` wrapper) — use `ApiGatewayHandler` from `@livequery/core` or `ApiGateway` from this package instead.
