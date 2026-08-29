import {
  API_GATEWAY_NAMESPACE,
  ApiGatewayHandler,
  type ServiceApiMetadata,
} from '@livequery/core'
import { UdpDiscovery } from '@ohayo/udp'

const discoveryPort = Number(process.env.OHAYO_DISCOVERY_PORT)
const gatewayId = process.env.GATEWAY_ID ?? `gateway-${process.pid}`
const discovery = new UdpDiscovery<ServiceApiMetadata>({
  namespace: API_GATEWAY_NAMESPACE,
  tags: ['livequery'],
  node_id: gatewayId,
  key: requiredEnv('OHAYO_DISCOVERY_KEY'),
  port: discoveryPort,
  peers: ['127.0.0.1'],
  broadcastCopies: 1,
})

const observation = discovery.subscribe(message => {
  if (message.data.role !== 'service') return
  emit({ event: 'service-discovered', nodeId: message.node_id })
})
const gateway = new ApiGatewayHandler({
  node_id: gatewayId,
  discovery,
})
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: request => gateway.fetch(request),
})

emit({ event: 'ready', kind: 'gateway', port: server.port, pid: process.pid })

function shutdown() {
  observation.unsubscribe()
  gateway.close()
  server.stop(true)
  process.exit(0)
}

process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function emit(event: Record<string, unknown>) {
  console.log(JSON.stringify(event))
}
