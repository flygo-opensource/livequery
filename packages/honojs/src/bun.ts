/**
 * Bun entry — `@livequery/honojs/bun`. The root entry plus the `Bun.serve` realtime gateway,
 * also exported as `WebsocketGateway` so only the import path changes between runtimes.
 */
export * from './index.js'
export { BunWebsocketGateway, WebsocketGateway } from '@livequery/core/bun'
