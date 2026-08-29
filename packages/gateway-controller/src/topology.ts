import type { ServiceManifest, ServiceRoute } from '@livequery/service'

export type ServiceTopology = {
  serviceId: string
  protocol: 'http' | 'https'
  routes: ServiceRoute[]
  targets: Array<{ instanceId: string; host: string; port: number }>
}

function canonicalPath(path: string): string {
  return `/${path.split('/').filter(Boolean).map(segment => {
    if (segment.startsWith(':')) return ':'
    const colon = segment.indexOf(':')
    return colon < 0 ? segment : `${segment.slice(0, colon)}:`
  }).join('/')}`
}

export function createServiceTopology(manifests: readonly ServiceManifest[]): ServiceTopology[] {
  const ready = manifests.filter(manifest => manifest.status === 'ready')
  const owners = new Map<string, string>()
  const services = new Map<string, ServiceTopology>()

  for (const manifest of ready) {
    if (manifest.endpoint.kind === 'binding') {
      throw new Error(`Network gateway controller cannot use binding endpoint ${manifest.endpoint.binding}`)
    }
    let service = services.get(manifest.serviceId)
    if (!service) {
      service = { serviceId: manifest.serviceId, protocol: manifest.endpoint.protocol, routes: manifest.routes, targets: [] }
      services.set(manifest.serviceId, service)
    }
    if (service.protocol !== manifest.endpoint.protocol || JSON.stringify(service.routes) !== JSON.stringify(manifest.routes)) {
      throw new Error(`Replicas of ${manifest.serviceId} publish different service definitions`)
    }
    service.targets.push({ instanceId: manifest.instanceId, host: manifest.endpoint.host, port: manifest.endpoint.port })

    for (const route of manifest.routes) {
      const key = `${route.method.toUpperCase()} ${canonicalPath(route.path)}`
      const owner = owners.get(key)
      if (owner && owner !== manifest.serviceId) throw new Error(`Route ${key} is owned by both ${owner} and ${manifest.serviceId}`)
      owners.set(key, manifest.serviceId)
    }
  }

  return [...services.values()].sort((a, b) => a.serviceId.localeCompare(b.serviceId))
}
