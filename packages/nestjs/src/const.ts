export const LIVEQUERY_MAGIC_KEY = `${process.env.LIVEQUERY_MAGIC_KEY || 'livequery'}/`

export const API_GATEWAY_NAMESPACE = process.env.API_GATEWAY_NAMESPACE || 'default'
export const API_GATEWAY_UDP_PORT = Number(process.env.API_GATEWAY_UDP_PORT || 13578)
export const SERVICE_API_UDP_PORT = Number(process.env.SERVICE_API_UDP_PORT || 13579)
export const API_GATEWAY_UDP_ADDRESS = process.env.API_GATEWAY_UDP_ADDRESS || '192.168.2'
export const LIVEQUERY_API_GATEWAY_DEBUG = process.env.LIVEQUERY_API_GATEWAY_DEBUG || true
export const LIVEQUERY_API_GATEWAY_RAW_DEBUG = process.env.LIVEQUERY_API_GATEWAY_RAW_DEBUG




