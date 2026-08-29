export type ServiceRouteAuth = 'public' | 'required' | 'internal'

export type ServiceRoute = {
  id: string
  method: string
  path: string
  targetPath?: string
  auth: ServiceRouteAuth
  timeoutMs?: number
}

export type NetworkServiceEndpoint = {
  kind?: 'network'
  protocol: 'http' | 'https'
  host: string
  port: number
}

export type BindingServiceEndpoint = {
  kind: 'binding'
  /** Deploy-time binding name, for example a Cloudflare Service Binding. */
  binding: string
}

export type ServiceEndpoint = NetworkServiceEndpoint | BindingServiceEndpoint

export type ServiceManifest = {
  schemaVersion: 1
  serviceId: string
  instanceId: string
  version: string
  protocolVersion: string
  endpoint: ServiceEndpoint
  routes: ServiceRoute[]
  health?: {
    livenessPath: string
    readinessPath: string
  }
  realtime?: {
    enabled: boolean
    publisher?: string
  }
  status: 'starting' | 'ready' | 'draining' | 'offline'
  seq: number
  updatedAt: number
}

export type ServiceManifestInput = Omit<ServiceManifest, 'instanceId' | 'status' | 'seq' | 'updatedAt'> & {
  instanceId?: string
  status?: ServiceManifest['status']
  seq?: number
  updatedAt?: number
}
