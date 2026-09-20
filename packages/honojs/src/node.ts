/**
 * Node.js entry — `@livequery/honojs/node`. The root entry plus the `ws`-based realtime gateway,
 * which needs the optional `ws` peer dependency.
 */
export * from './index.js'
export { WebsocketGateway } from '@livequery/core/node'
