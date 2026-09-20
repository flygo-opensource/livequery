/**
 * Node.js entry point — `@livequery/core/node`.
 *
 *   import { WebsocketGateway, UdpDiscovery, ApiGatewayHandler } from '@livequery/core/node'
 *
 * Re-exports the runtime-neutral root plus the Node adapters. `WebsocketGateway` needs the
 * `ws` package and `UdpDiscovery` needs `@ohayo/udp`; both are optional peer dependencies of
 * `@livequery/core`, so install the ones you use.
 */
export * from './index.js'
export * from './helpers/nodeRequestToWebRequest.js'
export * from './helpers/writeWebResponse.js'
export * from './WebsocketGateway.js'
export * from './HttpDiscovery.js'
export * from './ApiGatewayHandler.js'
export * from './ApiServiceLinker.js'
