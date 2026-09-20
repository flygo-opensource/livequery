/**
 * Bun entry point — `@livequery/core/bun`.
 *
 *   import { BunWebsocketGateway } from '@livequery/core/bun'
 *
 * Re-exports the runtime-neutral root plus the Bun gateway and the discovery / API gateway
 * pieces, which run on Bun's Node compatibility layer. Does not load the `ws` package.
 * `UdpDiscovery` needs `@ohayo/udp`, an optional peer dependency.
 */
export * from './index.js'
export * from './BunWebsocketGateway.js'
// Lets code written against the Node entry swap in the Bun gateway by changing the import path.
export { BunWebsocketGateway as WebsocketGateway } from './BunWebsocketGateway.js'
export * from './HttpDiscovery.js'
export * from './ApiGatewayHandler.js'
export * from './ApiServiceLinker.js'
export * from './helpers/nodeRequestToWebRequest.js'
export * from './helpers/writeWebResponse.js'
