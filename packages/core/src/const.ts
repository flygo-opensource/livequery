// Reads an environment variable where one exists. Workers without nodejs_compat and browsers
// have no `process`, so importing this module must not touch it unguarded.
function env(name: string): string | undefined {
    return typeof process !== 'undefined' ? process.env?.[name] : undefined
}

// Math.random() is safe at module scope in all runtimes including CF Workers
export const NODE_ID = Array.from({ length: 4 }, () => Math.random().toString(16).slice(2, 10)).join('-')
export const LIVEQUERY_API_GATEWAY_DEBUG = env('LIVEQUERY_API_GATEWAY_DEBUG') || false
export const WEBSOCKET_PATH = env('REALTIME_UPDATE_SOCKET_PATH') || '/livequery/realtime-updates'

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

/** Header a service sets so its gateway can subscribe the caller to the ref it just read. */
export const LIVEQUERY_REF_HEADER = 'x-livequery-ref'

/** Header a service sets after a write: `<type> <collection_ref>`, e.g. `modified tasks`. */
export const LIVEQUERY_CHANGE_HEADER = 'x-livequery-change'

/**
 * Keep-alive frames, byte for byte.
 *
 * On Cloudflare the runtime answers a ping itself through `setWebSocketAutoResponse`, which
 * compares the incoming frame as an **exact string** — so these two literals are part of the wire
 * protocol, not an implementation detail. A client must send this literal and nothing else: extra
 * whitespace, a different key order, an added field or a msgpack encoding of the same object all
 * stop matching, and then every idle ping wakes the Durable Object. Nothing breaks visibly; the
 * bill just grows. Change these only together with every client, and keep `tests/keepalive-frame`
 * green.
 */
export const LIVEQUERY_PING_FRAME = '{"event":"ping"}'
export const LIVEQUERY_PONG_FRAME = '{"event":"pong"}'
