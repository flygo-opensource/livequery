// Default entry point — Node adapter is exported as `WebsocketGateway` for
// backward compatibility with existing consumers (most were on Node).
//
// Runtime-specific entries:
//   import { ... } from '@livequery/core/node'
//   import { ... } from '@livequery/core/bun'
//   import { ... } from '@livequery/core/workers'
//
// Protocol-only (no runtime dependency):
//   import { WebsocketGatewayBase, SocketLike, RealtimeSubscription } from '@livequery/core'

export * from './WebsocketGatewayBase.js'
export * from './WebsocketGateway.js'
export * from './const.js'
export * from './UdpDiscovery.js'
export * from './ApiGatewayHandler.js'
export * from './ApiServiceLinker.js'
export * from './LivequeryContext.js'
export * from './LivequeryDatasource.js'
export * from './LivequeryRequestParser.js'
export * from './helpers/hidePrivateFields.js'
