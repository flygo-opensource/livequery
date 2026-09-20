/**
 * API gateway on Node.js.
 *
 *   node examples/api-gateway/node/gateway.ts
 *
 * Clients talk only to this process: HTTP requests are proxied to the service that registered
 * the route, and the WebSocket at /livequery/realtime-updates carries realtime changes.
 */
import { createServer, type IncomingMessage } from 'node:http'
import {
    API_GATEWAY_NAMESPACE,
    ApiGatewayHandler,
    HttpDiscovery,
    WebsocketGateway,
    nodeRequestToWebRequest,
    writeWebResponse,
    type ServiceApiMetadata,
} from '@livequery/core/node'
import { DISCOVERY_PORT, GATEWAY_PORT } from '../shared/config.ts'
import { withCors } from '../shared/withCors.ts'

const server = createServer(async (req, res) => {
    const request = nodeRequestToWebRequest(req as IncomingMessage & { url: string; method: string })
    await writeWebResponse(res, await withCors(request, () => gateway.fetch(request)))
})

// Client-facing realtime endpoint. Clients connect here, never to a service directly.
const realtime = new WebsocketGateway(server)

// Registry that services register with (listen: true opens it on DISCOVERY_PORT).
const discovery = new HttpDiscovery<ServiceApiMetadata>({
    namespace: API_GATEWAY_NAMESPACE,
    tags: ['livequery'],
    port: DISCOVERY_PORT,
})

// Builds the route table from discovery, proxies HTTP with timeouts and failover, and links its
// realtime gateway to each service's realtime gateway.
const gateway = new ApiGatewayHandler({ ws: realtime, discovery })

server.listen(GATEWAY_PORT, () => {
    console.log(JSON.stringify({ event: 'ready', kind: 'gateway', runtime: 'node', port: GATEWAY_PORT }))
})

function shutdown() {
    gateway.close()
    realtime.close()
    server.close(() => process.exit(0))
}

process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
