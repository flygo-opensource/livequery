export const LIVEQUERY_MAGIC_KEY = `${process.env.LIVEQUERY_MAGIC_KEY || 'livequery'
    }/`

export const API_GATEWAY_NAMESPACE = process.env.API_GATEWAY_NAMESPACE || 'default'
export const API_GATEWAY_UDP_PORT = Number(process.env.API_GATEWAY_UDP_PORT || 13579)
export const API_GATEWAY_UDP_ADDRESS =  process.env.API_GATEWAY_UDP_ADDRESS || ''