// Reads an environment variable where one exists. Workers without nodejs_compat and browsers
// have no `process`, so importing this module must not touch it unguarded.
function env(name: string): string | undefined {
    return typeof process !== 'undefined' ? process.env?.[name] : undefined
}

export const API_GATEWAY_NAMESPACE = env('OHAYO_DISCOVERY_NAMESPACE') || 'default'
export const OHAYO_DISCOVERY_KEY = env('OHAYO_DISCOVERY_KEY') || 'livequery'
export const OHAYO_DISCOVERY_PORT = Number(env('OHAYO_DISCOVERY_PORT') || 12001)
export const OHAYO_API_GATEWAY = env('OHAYO_API_GATEWAY') || ''
export const OHAYO_WS_GATEWAY = env('OHAYO_WS_GATEWAY') || ''
export const API_GATEWAY_MULTICAST_PORT = Number(env('OHAYO_DISCOVERY_PORT') || 11001)
export const API_GATEWAY_MULTICAST_ADDRESS = env('OHAYO_UDP_MULTICAST_ADDRESS') || '239.0.1.1'
export const API_GATEWAY_WHITELIST_ADDRESS = env('OHAYO_UDP_WHITELIST_ADDRESS') || ''
// Math.random() is safe at module scope in all runtimes including CF Workers
export const NODE_ID = Array.from({ length: 4 }, () => Math.random().toString(16).slice(2, 10)).join('-')
export const LIVEQUERY_API_GATEWAY_DEBUG = env('LIVEQUERY_API_GATEWAY_DEBUG') || false
export const WEBSOCKET_PATH = env('REALTIME_UPDATE_SOCKET_PATH') || '/livequery/realtime-updates'

// Upstream-request timeout for the API gateway proxy, in milliseconds. Configured via
// LIVEQUERY_GATEWAY_TIMEOUT (in SECONDS); defaults to 30s. Bounds a hung upstream — one
// that accepts the TCP connection but never responds — so it can't hold a gateway request
// (and its sockets/file-descriptors) open forever. Invalid / non-positive values fall back to 30s.
const GATEWAY_TIMEOUT_SECONDS = Number(env('LIVEQUERY_GATEWAY_TIMEOUT'))
export const LIVEQUERY_GATEWAY_TIMEOUT_MS = (GATEWAY_TIMEOUT_SECONDS > 0 ? GATEWAY_TIMEOUT_SECONDS : 30) * 1000

/**
 * Hono context variable names shared by the Livequery middlewares. A datasource middleware writes
 * `livequery_result`; `realtime()` reads it. Using names instead of imports keeps the datasource
 * packages independent of the Hono adapter.
 */
export const LIVEQUERY_VARS = {
    /** Parsed request, written by `livequery()`. */
    request: 'livequery',
    /** Validation schema for the route, written by `validator()`; doubles as the column allowlist. */
    schema: 'livequery_schema',
    /** Body after validation, so defaults and transforms survive. */
    body: 'livequery_body',
    /** Datasource result, written by the datasource middleware before it calls next(). */
    result: 'livequery_result',
} as const
