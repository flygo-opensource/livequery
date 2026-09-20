/**
 * Tasks service API on Node.js.
 *
 *   node examples/api-gateway/node/service.ts
 *
 * Serves the task routes over plain `http`, runs a realtime gateway on the same port for the API
 * gateway to connect to, and registers itself with the gateway's discovery registry.
 */
import { createServer, type IncomingMessage } from 'node:http'
import {
    API_GATEWAY_NAMESPACE,
    ApiServiceLinker,
    HttpDiscovery,
    WebsocketGateway,
    nodeRequestToWebRequest,
    writeWebResponse,
    type ServiceApiMetadata,
} from '@livequery/core/node'
import { DISCOVERY_URL, SERVICE_PORT } from '../shared/config.ts'
import { TASK_ROUTES, handleTaskRequest } from '../shared/handleTaskRequest.ts'
import { TaskStore } from '../shared/TaskStore.ts'

const node_id = `tasks-node-${process.pid}`
const store = new TaskStore()

const server = createServer(async (req, res) => {
    const request = nodeRequestToWebRequest(req as IncomingMessage & { url: string; method: string })
    await writeWebResponse(res, await handleTaskRequest(request, store, realtime))
})

// Realtime gateway on the service port. The API gateway opens a gateway-to-gateway WebSocket to
// it; every change on this gateway travels over that link to the subscribed clients.
const realtime = new WebsocketGateway(server)
const changes = store.changes$.subscribe(change => realtime.next(change))

// Announces host, port, routes and the realtime endpoint to the gateway's registry, then keeps
// heartbeating so a gateway that restarts learns about the service again.
const linker = new ApiServiceLinker({
    node_id,
    paths: TASK_ROUTES,
    ws: realtime,
    discovery: new HttpDiscovery<ServiceApiMetadata>({
        namespace: API_GATEWAY_NAMESPACE,
        tags: ['livequery'],
        node_id,
        listen: false,
        gateways: [DISCOVERY_URL],
    }),
})

server.listen(SERVICE_PORT, () => {
    linker.start('tasks', SERVICE_PORT)
    console.log(JSON.stringify({ event: 'ready', kind: 'service', runtime: 'node', port: SERVICE_PORT }))
})

function shutdown() {
    linker.close()
    changes.unsubscribe()
    realtime.close()
    server.close(() => process.exit(0))
}

process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
