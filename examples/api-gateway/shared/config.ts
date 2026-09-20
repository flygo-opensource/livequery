// Settings shared by the gateway and the service of every runtime. Override them with env vars.
export const GATEWAY_PORT = Number(process.env.GATEWAY_PORT ?? 8080)
export const SERVICE_PORT = Number(process.env.SERVICE_PORT ?? 8081)

// The gateway runs the HTTP discovery registry on this port; services register with it.
export const DISCOVERY_PORT = Number(process.env.OHAYO_DISCOVERY_PORT ?? 12001)
export const DISCOVERY_URL = process.env.DISCOVERY_URL ?? `http://127.0.0.1:${DISCOVERY_PORT}`
