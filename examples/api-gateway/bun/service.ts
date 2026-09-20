/**
 * Tasks service API on Bun.
 *
 *   bun examples/api-gateway/bun/service.ts
 *
 * Same service as node/service.ts, served by Bun.serve. The realtime gateway shares the port:
 * WebSocket upgrades on /livequery/realtime-updates go to it, everything else to the API.
 */
import {
    API_GATEWAY_NAMESPACE,
    ApiServiceLinker,
    BunWebsocketGateway,
    HttpDiscovery,
    type ServiceApiMetadata,
} from '@livequery/core/bun'
import { DISCOVERY_URL, SERVICE_PORT } from '../shared/config.ts'
import { TASK_ROUTES, handleTaskRequest } from '../shared/handleTaskRequest.ts'
import { TaskStore } from '../shared/TaskStore.ts'

const node_id = `tasks-bun-${process.pid}`
const store = new TaskStore()

// The API gateway opens a gateway-to-gateway WebSocket here; changes travel over it to clients.
const realtime = new BunWebsocketGateway()
const changes = store.changes$.subscribe(change => realtime.next(change))

const server = Bun.serve({
    port: SERVICE_PORT,
    fetch(request, bun_server) {
        if (realtime.attachBunUpgrade(request, bun_server)) return undefined
        return handleTaskRequest(request, store, realtime)
    },
    websocket: realtime.getBunWebsocketHandlers(),
})

// Announces host, port, routes and the realtime endpoint to the gateway's registry.
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
linker.start('tasks', SERVICE_PORT)
console.log(JSON.stringify({ event: 'ready', kind: 'service', runtime: 'bun', port: server.port }))

function shutdown() {
    linker.close()
    changes.unsubscribe()
    realtime.close()
    server.stop(true)
    process.exit(0)
}

process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
