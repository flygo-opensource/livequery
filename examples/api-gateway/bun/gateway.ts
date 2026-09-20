/**
 * API gateway on Bun.
 *
 *   bun examples/api-gateway/bun/gateway.ts
 *
 * Same gateway as node/gateway.ts, served by Bun.serve. WebSocket upgrades on
 * /livequery/realtime-updates go to the client-facing realtime gateway; every other request is
 * proxied to the service that registered its route.
 */
import {
    API_GATEWAY_NAMESPACE,
    ApiGatewayHandler,
    BunWebsocketGateway,
    HttpDiscovery,
    type ServiceApiMetadata,
} from '@livequery/core/bun'
import { DISCOVERY_PORT, GATEWAY_PORT } from '../shared/config.ts'
import { withCors } from '../shared/withCors.ts'

const realtime = new BunWebsocketGateway()

// Registry that services register with (listen: true opens it on DISCOVERY_PORT).
const discovery = new HttpDiscovery<ServiceApiMetadata>({
    namespace: API_GATEWAY_NAMESPACE,
    tags: ['livequery'],
    port: DISCOVERY_PORT,
})

const gateway = new ApiGatewayHandler({ ws: realtime, discovery })

const server = Bun.serve({
    port: GATEWAY_PORT,
    fetch(request, bun_server) {
        if (realtime.attachBunUpgrade(request, bun_server)) return undefined
        return withCors(request, () => gateway.fetch(request))
    },
    websocket: realtime.getBunWebsocketHandlers(),
})
console.log(JSON.stringify({ event: 'ready', kind: 'gateway', runtime: 'bun', port: server.port }))

function shutdown() {
    gateway.close()
    realtime.close()
    server.stop(true)
    process.exit(0)
}

process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
