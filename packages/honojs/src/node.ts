/**
 * Node.js entry — `@livequery/honojs/node`. Root plus the gateway, the service linker and the
 * `ws`-based realtime gateway (needs the `ws` package). Pair it with `@hono/node-server`.
 */
export * from './index.js'
export * from './server.js'
export { WebsocketGateway } from '@livequery/core/node'
