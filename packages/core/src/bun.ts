/**
 * Bun entry point — `@livequery/core/bun`.
 *
 *   import { BunWebsocketGateway } from '@livequery/core/bun'
 *
 * The runtime-neutral root plus the `Bun.serve` WebSocket gateway. Loads no `ws`.
 */
export * from './index.js'
export * from './BunWebsocketGateway.js'
// Lets code written against the Node entry swap in the Bun gateway by changing the import path.
export { BunWebsocketGateway as WebsocketGateway } from './BunWebsocketGateway.js'
export * from './helpers/nodeRequestToWebRequest.js'
export * from './helpers/writeWebResponse.js'
