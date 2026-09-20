/**
 * Node.js entry point — `@livequery/core/node`.
 *
 *   import { WebsocketGateway } from '@livequery/core/node'
 *
 * The runtime-neutral root plus the Node WebSocket gateway, which needs the optional `ws` peer
 * dependency, and the helpers that bridge `http.IncomingMessage` to the Fetch API.
 */
export * from './index.js'
export * from './WebsocketGateway.js'
export * from './helpers/nodeRequestToWebRequest.js'
export * from './helpers/writeWebResponse.js'
