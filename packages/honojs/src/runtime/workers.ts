/**
 * Cloudflare Workers build of `@livequery/honojs`, selected by the `workerd` export condition.
 *
 *   export default serve(app)
 */
export * from '../index.js'
import type { FetchApp, ServeOptions } from './types.js'
export type { FetchApp, ServeOptions } from './types.js'

/** The Worker runtime owns the port and the sockets, so the app is already the export. */
export function serve<App extends FetchApp>(app: App, _options: ServeOptions = {}): App {
    return app
}
