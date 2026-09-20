// Default entry — runtime-neutral: Hono middleware, request/response helpers, route registry and
// datasource mapper. Safe on Cloudflare Workers; loads no Node built-in, `ws` or UDP transport.
//
// Server-side gateway and service linker:
//   import { HonoApiGateway, HonoApiServiceLinker, WebsocketGateway } from '@livequery/honojs/bun'
//   import { HonoApiGateway, HonoApiServiceLinker, WebsocketGateway } from '@livequery/honojs/node'

export * from './types.js'
export * from './realtime.js'
export * from './request.js'
export * from './response.js'
export * from './middleware.js'
export * from './route-registry.js'
export * from './datasource.js'
export {
    type LivequeryDatasource,
    type LivequeryDatasourceInitConfig,
    type LivequeryRequest,
    type RealtimeSubscription,
} from '@livequery/core'
