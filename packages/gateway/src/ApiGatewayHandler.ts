import type { ServiceManifest, ServiceRoute } from '@livequery/service'

type Fetch = typeof globalThis.fetch

type CompiledRoute = {
  key: string
  serviceId: string
  route: ServiceRoute
  expression: RegExp
  parameterNames: string[]
  score: number
  instances: Map<string, ServiceManifest>
  roundRobinIndex: number
}

export type ApiGatewayHandlerOptions = {
  fetch?: Fetch
  timeoutMs?: number
  prepareHeaders?: (request: Request, headers: Headers) => void | Promise<void>
}

export class RouteConflictError extends Error {
  constructor(method: string, path: string, owner: string, contender: string) {
    super(`Route ${method} ${path} is owned by ${owner}; ${contender} cannot register it`)
    this.name = 'RouteConflictError'
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizePath(path: string): string {
  const normalized = `/${path.split('/').filter(Boolean).join('/')}`
  return normalized === '/' ? '/' : normalized.replace(/\/$/, '')
}

function canonicalRoutePath(path: string): string {
  return normalizePath(path).split('/').map(segment => {
    if (segment.startsWith(':')) return ':'
    const colon = segment.indexOf(':')
    return colon < 0 ? segment : `${segment.slice(0, colon)}:`
  }).join('/')
}

function compilePath(path: string): Pick<CompiledRoute, 'expression' | 'parameterNames' | 'score'> {
  const parameterNames: string[] = []
  let score = 0
  const segments = normalizePath(path).split('/').filter(Boolean)
  const source = segments.map((segment, index) => {
    if (segment === ':' || segment.startsWith(':')) {
      parameterNames.push(segment.slice(1) || `param${index}`)
      score += 1
      return '([^/]+)'
    }
    const colon = segment.indexOf(':')
    if (colon >= 0) {
      parameterNames.push(segment.slice(colon + 1) || `param${index}`)
      score += 2
      return `${escapeRegExp(segment.slice(0, colon))}([^/]+)`
    }
    score += 3
    return escapeRegExp(segment)
  }).join('/')
  return {
    expression: new RegExp(`^/${source}/?$`),
    parameterNames,
    score: score * 100 + segments.length,
  }
}

export class ApiGatewayHandler {
  readonly #fetch: Fetch
  readonly #timeoutMs: number
  readonly #prepareHeaders?: ApiGatewayHandlerOptions['prepareHeaders']
  readonly #routes = new Map<string, CompiledRoute>()
  readonly #instanceRoutes = new Map<string, Set<string>>()

  constructor(options: ApiGatewayHandlerOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#timeoutMs = options.timeoutMs ?? 30_000
    this.#prepareHeaders = options.prepareHeaders
  }

  register(manifest: ServiceManifest): void {
    if (manifest.status !== 'ready') {
      this.deregister(manifest.instanceId)
      return
    }
    if (manifest.endpoint.kind === 'binding') {
      throw new Error(`Fetch gateway cannot dial binding endpoint ${manifest.endpoint.binding}`)
    }

    for (const route of manifest.routes) {
      const method = route.method.toUpperCase()
      const path = normalizePath(route.path)
      const key = `${method} ${canonicalRoutePath(path)}`
      const entry = this.#routes.get(key)
      if (entry && entry.serviceId !== manifest.serviceId) {
        throw new RouteConflictError(method, path, entry.serviceId, manifest.serviceId)
      }
    }

    this.deregister(manifest.instanceId)

    const keys = new Set<string>()
    for (const route of manifest.routes) {
      const method = route.method.toUpperCase()
      const path = normalizePath(route.path)
      const key = `${method} ${canonicalRoutePath(path)}`
      let entry = this.#routes.get(key)
      if (entry && entry.serviceId !== manifest.serviceId) {
        throw new RouteConflictError(method, path, entry.serviceId, manifest.serviceId)
      }
      if (!entry) {
        const compiled = compilePath(path)
        entry = {
          key,
          serviceId: manifest.serviceId,
          route: { ...route, method, path },
          ...compiled,
          instances: new Map(),
          roundRobinIndex: 0,
        }
        this.#routes.set(key, entry)
      }
      entry.instances.set(manifest.instanceId, manifest)
      keys.add(key)
    }
    this.#instanceRoutes.set(manifest.instanceId, keys)
  }

  applyManifest(manifest: ServiceManifest): void {
    if (manifest.status === 'ready') this.register(manifest)
    else this.deregister(manifest.instanceId)
  }

  deregister(instanceId: string): void {
    const keys = this.#instanceRoutes.get(instanceId)
    if (!keys) return
    for (const key of keys) {
      const route = this.#routes.get(key)
      route?.instances.delete(instanceId)
      if (route?.instances.size === 0) this.#routes.delete(key)
    }
    this.#instanceRoutes.delete(instanceId)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const match = this.#match(request.method, url.pathname)
    if (!match) {
      return Response.json({ error: { status: 404, code: 'API_NOT_FOUND', message: `No service registered for ${request.method} ${url.pathname}` } }, { status: 404 })
    }

    const instances = [...match.route.instances.values()]
    if (instances.length === 0) {
      return Response.json({ error: { status: 503, code: 'API_OFFLINE', message: `No ready instance for ${request.method} ${url.pathname}` } }, { status: 503 })
    }

    const headers = new Headers(request.headers)
    for (const name of ['host', 'content-length', 'x-livequery-user-id', 'x-livequery-service-id', 'x-livequery-gateway-id']) {
      headers.delete(name)
    }
    headers.set('x-livequery-service-id', match.route.serviceId)
    await this.#prepareHeaders?.(request, headers)

    const start = match.route.roundRobinIndex % instances.length
    match.route.roundRobinIndex = (match.route.roundRobinIndex + 1) % Number.MAX_SAFE_INTEGER
    let lastError: unknown
    for (let offset = 0; offset < instances.length; offset++) {
      const manifest = instances[(start + offset) % instances.length]
      if (!manifest) continue
      if (manifest.endpoint.kind === 'binding') continue
      const targetPath = this.#targetPath(match.route.route, match.parameters, url.pathname)
      const target = `${manifest.endpoint.protocol}://${manifest.endpoint.host}:${manifest.endpoint.port}${targetPath}${url.search}`
      const timeout = match.route.route.timeoutMs ?? this.#timeoutMs
      try {
        return await this.#fetch(target, {
          method: request.method,
          headers,
          body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
          redirect: 'manual',
          signal: AbortSignal.timeout(timeout),
          duplex: request.body ? 'half' : undefined,
        } as RequestInit)
      } catch (error) {
        lastError = error
      }
    }

    const timedOut = lastError instanceof DOMException && lastError.name === 'TimeoutError'
    const status = timedOut ? 504 : 502
    const code = timedOut ? 'SERVICE_API_TIMEOUT' : 'SERVICE_API_OFFLINE'
    return Response.json({ error: { status, code, message: String(lastError ?? 'Upstream unavailable') } }, { status })
  }

  close(): void {
    this.#routes.clear()
    this.#instanceRoutes.clear()
  }

  #match(method: string, pathname: string): { route: CompiledRoute; parameters: Record<string, string> } | undefined {
    const candidates = [...this.#routes.values()]
      .filter(route => route.route.method === method.toUpperCase())
      .sort((a, b) => b.score - a.score)
    for (const route of candidates) {
      const match = route.expression.exec(normalizePath(pathname))
      if (!match) continue
      const parameters = Object.fromEntries(route.parameterNames.map((name, index) => [name, match[index + 1] ?? '']))
      return { route, parameters }
    }
    return undefined
  }

  #targetPath(route: ServiceRoute, parameters: Record<string, string>, fallback: string): string {
    if (!route.targetPath) return fallback
    return normalizePath(route.targetPath.replace(/:([a-zA-Z0-9_]*)/g, (_match, name: string) => {
      if (name && parameters[name] !== undefined) return parameters[name]
      return Object.values(parameters).shift() ?? ''
    }))
  }
}
