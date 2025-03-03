export const LIVEQUERY_MAGIC_KEY = `${process.env.LIVEQUERY_MAGIC_KEY || 'livequery'}/`

export const API_GATEWAY_NAMESPACE = process.env.API_GATEWAY_NAMESPACE || 'default'
export const API_GATEWAY_UDP_ADDRESS = process.env.API_GATEWAY_UDP_ADDRESS || ''
export const LIVEQUERY_API_GATEWAY_DEBUG = process.env.LIVEQUERY_API_GATEWAY_DEBUG || true
export const LIVEQUERY_API_GATEWAY_RAW_DEBUG = process.env.LIVEQUERY_API_GATEWAY_RAW_DEBUG

export const UDP_PUBLIC_PORT = Number(process.env.UDP_PUBLIC_PORT || 11001)
export const UDP_LOCAL_PORT = Number(process.env.UDP_LOCAL_PORT || 11002)
export const UDP_MULTICAST_ADDRESS = process.env.UDP_MULTICAST_ADDRESS || '224.0.0.1'




