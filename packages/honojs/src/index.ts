// Default entry — runtime-neutral: the Livequery middlewares (validator, livequery, realtime,
// gateway), request/response helpers, route registry and datasource mapper. Safe on Cloudflare
// Workers; loads no Node built-in and no `ws`.
//
// The realtime gateway that holds client sockets is runtime-specific:
//   import { WebsocketGateway } from '@livequery/honojs/node'   // ws
//   import { WebsocketGateway } from '@livequery/honojs/bun'    // Bun.serve

export * from './types.js'
export * from './realtime.js'
export * from './realtimeMiddleware.js'
export * from './gateway.js'
export * from './request.js'
export * from './response.js'
export * from './errorHandler.js'
export * from './middleware.js'
export * from './validator.js'
export * from './route-registry.js'
export * from './datasource.js'
export {
    LIVEQUERY_CHANGE_HEADER,
    LIVEQUERY_REF_HEADER,
    type LivequeryDatasource,
    type LivequeryDatasourceInitConfig,
    type LivequeryRequest,
    type RealtimeSubscription,
} from '@livequery/core'
