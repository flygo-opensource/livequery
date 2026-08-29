import { createServiceTopology } from '@livequery/gateway-controller'
import type { ServiceManifest } from '@livequery/service'

export function renderKongConfig(manifests: readonly ServiceManifest[]) {
  const topology = createServiceTopology(manifests)
  return {
    _format_version: '3.0',
    upstreams: topology.map(service => ({
      name: service.serviceId,
      targets: service.targets.map(target => ({ target: `${target.host}:${target.port}`, weight: 100 })),
    })),
    services: topology.map(service => ({
      name: service.serviceId,
      protocol: service.protocol,
      host: service.serviceId,
      routes: service.routes.map(route => ({
        name: route.id,
        methods: [route.method.toUpperCase()],
        paths: [route.path],
        strip_path: false,
      })),
    })),
  }
}
