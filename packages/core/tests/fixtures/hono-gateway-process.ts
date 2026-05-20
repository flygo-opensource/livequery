import { ApiGatewayHandler } from '../../src/ApiGatewayHandler.js'

const gateway = new ApiGatewayHandler({
    node_id: `api-gateway-${process.pid}`,
})

const server = Bun.serve({
    port: 0,
    fetch: request => gateway.fetch(request),
})

console.log(JSON.stringify({
    event: 'ready',
    kind: 'gateway',
    pid: process.pid,
    port: server.port,
}))

function shutdown() {
    gateway.close()
    server.stop(true)
    process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
