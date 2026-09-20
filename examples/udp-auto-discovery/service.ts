import {
  API_GATEWAY_NAMESPACE,
  ApiServiceLinker,
  type ServiceApiMetadata,
} from '@livequery/core/node'
import { UdpDiscovery } from '@ohayo/udp'

const discoveryPort = Number(process.env.OHAYO_DISCOVERY_PORT)
const serviceId = process.env.SERVICE_ID ?? `catalog-${process.pid}`
const discovery = new UdpDiscovery<ServiceApiMetadata>({
  namespace: API_GATEWAY_NAMESPACE,
  tags: ['livequery'],
  node_id: serviceId,
  key: requiredEnv('OHAYO_DISCOVERY_KEY'),
  port: discoveryPort,
  peers: ['127.0.0.1'],
  broadcastCopies: 1,
})

const observation = discovery.subscribe(message => {
  if (message.data.role !== 'gateway') return
  emit({ event: 'gateway-discovered', nodeId: message.node_id })
})

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname !== '/livequery/catalog') {
      return Response.json({ error: 'not_found' }, { status: 404 })
    }
    return Response.json({
      service: 'catalog',
      serviceId,
      processId: process.pid,
    })
  },
})
const servicePort = server.port
if (typeof servicePort !== 'number') throw new Error('Bun did not allocate a TCP port')

const linker = new ApiServiceLinker({
  node_id: serviceId,
  discovery,
  paths: [{ method: 'GET', path: '/livequery/catalog' }],
})
linker.start('catalog', servicePort)
emit({ event: 'ready', kind: 'service', port: servicePort, pid: process.pid })

function shutdown() {
  observation.unsubscribe()
  linker.close()
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
