export const API_GATEWAY_NAMESPACE = typeof process !== 'undefined' ? process.env.OHAYO_DISCOVERY_NAMESPACE || 'default' : 'default'
export const OHAYO_DISCOVERY_KEY = typeof process !== 'undefined' ? process.env.OHAYO_DISCOVERY_KEY || 'livequery' : 'livequery'
export const OHAYO_DISCOVERY_PORT = typeof process !== 'undefined' ? Number(process.env.OHAYO_DISCOVERY_PORT || 12001) : 12001
export const OHAYO_API_GATEWAY = typeof process !== 'undefined' ? process.env.OHAYO_API_GATEWAY || '' : ''
export const OHAYO_WS_GATEWAY = typeof process !== 'undefined' ? process.env.OHAYO_WS_GATEWAY || '' : ''
export const API_GATEWAY_MULTICAST_PORT = typeof process !== 'undefined' ? Number(process.env.OHAYO_DISCOVERY_PORT || 11001) : 11001
export const API_GATEWAY_MULTICAST_ADDRESS = typeof process !== 'undefined' ? process.env.OHAYO_UDP_MULTICAST_ADDRESS || "239.0.1.1" : "239.0.1.1"
export const API_GATEWAY_WHITELIST_ADDRESS = typeof process !== 'undefined' ? process.env.OHAYO_UDP_WHITELIST_ADDRESS || '' : ''
// Math.random() is safe at module scope in all runtimes including CF Workers
export const NODE_ID = Array.from({ length: 4 }, () => Math.random().toString(16).slice(2, 10)).join('-')
export const LIVEQUERY_API_GATEWAY_DEBUG = process.env.LIVEQUERY_API_GATEWAY_DEBUG || false
export const WEBSOCKET_PATH = process.env.REALTIME_UPDATE_SOCKET_PATH || '/livequery/realtime-updates'

// Upstream-request timeout for the API gateway proxy, in milliseconds. Configured via
// LIVEQUERY_GATEWAY_TIMEOUT (in SECONDS); defaults to 30s. Bounds a hung upstream — one
// that accepts the TCP connection but never responds — so it can't hold a gateway request
// (and its sockets/file-descriptors) open forever. Invalid / non-positive values fall back to 30s.
const GATEWAY_TIMEOUT_SECONDS = Number(process.env.LIVEQUERY_GATEWAY_TIMEOUT)
export const LIVEQUERY_GATEWAY_TIMEOUT_MS = (GATEWAY_TIMEOUT_SECONDS > 0 ? GATEWAY_TIMEOUT_SECONDS : 30) * 1000
