import type { ServiceManifest } from '@livequery/service'

function bindingName(serviceId: string): string {
  return `SERVICE_${serviceId.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`
}

export function renderCloudflarePlan(manifests: readonly ServiceManifest[]) {
  const services = new Map<string, ReturnType<typeof createPlan>>()
  for (const manifest of manifests.filter(item => item.status === 'ready')) {
    const plan = createPlan(manifest)
    const existing = services.get(manifest.serviceId)
    if (existing && JSON.stringify(existing) !== JSON.stringify(plan)) {
      throw new Error(`Replicas of ${manifest.serviceId} publish different Cloudflare plans`)
    }
    services.set(manifest.serviceId, plan)
  }
  return [...services.values()].sort((a, b) => a.serviceId.localeCompare(b.serviceId))
}

function createPlan(manifest: ServiceManifest) {
  return {
    serviceId: manifest.serviceId,
    binding: manifest.endpoint.kind === 'binding' ? manifest.endpoint.binding : bindingName(manifest.serviceId),
    routes: manifest.routes.map(route => ({ id: route.id, method: route.method.toUpperCase(), path: route.path })),
  }
}
