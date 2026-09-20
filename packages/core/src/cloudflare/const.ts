// Header the public Worker uses to pass the authenticated principal to the Durable Object.
// The router always overwrites it, so a client cannot choose its own principal.
export const LIVEQUERY_PRINCIPAL_HEADER = 'x-livequery-principal'

// Internal Durable Object endpoints. They are only reachable through a stub, because the
// router forwards WebSocket upgrades and nothing else.
export const LIVEQUERY_DO_BROADCAST_PATH = '/__livequery/broadcast'
export const LIVEQUERY_DO_SUBSCRIBE_PATH = '/__livequery/subscribe'

// Longest client id accepted in `start`. Client ids are UUIDs; the cap keeps storage keys small.
export const MAX_CLIENT_ID_LENGTH = 128
