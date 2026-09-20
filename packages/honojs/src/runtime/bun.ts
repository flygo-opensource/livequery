/**
 * Bun build of `@livequery/honojs`, selected by the `bun` export condition.
 *
 *   export default serve(app, { port: 8080, realtime: gateway })
 *
 * Bun serves a default export that carries `fetch`, so the returned object is the whole server
 * definition: WebSocket upgrades on the realtime path go to the gateway, everything else to the app.
 */
export * from '../index.js'
import type { FetchApp, ServeOptions } from './types.js'
export type { FetchApp, ServeOptions } from './types.js'

type BunGateway = {
    attachBunUpgrade(request: Request, server: unknown): boolean
    getBunWebsocketHandlers(): unknown
}

function isBunGateway(value: unknown): value is BunGateway {
    return typeof (value as BunGateway | undefined)?.attachBunUpgrade === 'function'
}

export function serve(app: FetchApp, options: ServeOptions = {}) {
    const gateway = isBunGateway(options.realtime) ? options.realtime : undefined
    return {
        port: options.port,
        fetch(request: Request, server: unknown) {
            if (gateway?.attachBunUpgrade(request, server)) return undefined
            return app.fetch(request)
        },
        ...gateway ? { websocket: gateway.getBunWebsocketHandlers() } : {},
    }
}

/** The realtime gateway for this runtime: `BunWebsocketGateway`, on `Bun.serve`. */
export async function realtimeGateway(options: Record<string, unknown> = {}) {
    const { BunWebsocketGateway } = await import('@livequery/core/bun')
    return new BunWebsocketGateway(options)
}
