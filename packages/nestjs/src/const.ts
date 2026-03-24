import { randomUUID } from "crypto"

export const API_GATEWAY_NAMESPACE = process.env.API_GATEWAY_NAMESPACE || 'default'
export const LIVEQUERY_MAGIC_KEY = `${process.env.LIVEQUERY_MAGIC_KEY || 'livequery'}/`
export const API_GATEWAY_MULTICAST_PORT = Number(process.env.UDP_PUBLIC_PORT || 11001)
export const API_GATEWAY_MULTICAST_ADDRESS = process.env.UDP_MULTICAST_ADDRESS || "239.0.1.1"
export const API_GATEWAY_WHITELIST_ADDRESS = process.env.UDP_WHITELIST_ADDRESS || ''
export const NODE_ID = randomUUID()
export const LIVEQUERY_API_GATEWAY_DEBUG = process.env.LIVEQUERY_API_GATEWAY_DEBUG || false 
