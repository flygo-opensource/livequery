// Settings shared by the gateway and the service of every runtime. Override them with env vars.
export const GATEWAY_PORT = Number(process.env.GATEWAY_PORT ?? 8080)
export const SERVICE_PORT = Number(process.env.SERVICE_PORT ?? 8081)

// Where the gateway reaches the service. routing.json carries the same default; this override
// exists so tests (and containers) can move the service without editing the file.
export const SERVICE_URL = process.env.SERVICE_URL ?? `http://127.0.0.1:${SERVICE_PORT}`
