import { randomUUID } from "crypto"

export const API_GATEWAY_NAMESPACE = process.env.API_GATEWAY_NAMESPACE || 'default'
export const LIVEQUERY_MAGIC_KEY = `${process.env.LIVEQUERY_MAGIC_KEY || 'livequery'}/`
export const API_GATEWAY_MULTICAST_PORT = Number(process.env.UDP_PUBLIC_PORT || 11001)
export const API_GATEWAY_MULTICAST_ADDRESS = process.env.UDP_MULTICAST_ADDRESS || "239.0.1.1"
export const API_GATEWAY_WHITELIST_ADDRESS = process.env.UDP_WHITELIST_ADDRESS || ''
export const NODE_ID = randomUUID()
export const LIVEQUERY_API_GATEWAY_DEBUG = process.env.LIVEQUERY_API_GATEWAY_DEBUG || false
export const WEBSOCKET_PATH = process.env.REALTIME_UPDATE_SOCKET_PATH || '/livequery/realtime-updates'

// Upstream-request timeout for the API gateway proxy, in milliseconds. Configured via
// LIVEQUERY_GATEWAY_TIMEOUT (in SECONDS); defaults to 30s. Bounds a hung upstream — one
// that accepts the TCP connection but never responds — so it can't hold a gateway request
// (and its sockets/file-descriptors) open forever. Invalid / non-positive values fall back to 30s.
const GATEWAY_TIMEOUT_SECONDS = Number(process.env.LIVEQUERY_GATEWAY_TIMEOUT)
export const LIVEQUERY_GATEWAY_TIMEOUT_MS = (GATEWAY_TIMEOUT_SECONDS > 0 ? GATEWAY_TIMEOUT_SECONDS : 30) * 1000
