/**
 * Node.js entry point — explicit `@livequery/core/node` import.
 *
 *   import { WebsocketGateway } from '@livequery/core/node'
 *
 * Same as importing `WebsocketGateway` from `@livequery/core` (the default
 * export). Provided for symmetry with `/bun` and `/workers`.
 */
export { WebsocketGateway } from './WebsocketGateway.js'
export * from './index.js'
