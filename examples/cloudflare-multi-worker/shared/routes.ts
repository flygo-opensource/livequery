export type GatewayBinding = 'TASKS_SERVICE' | 'INCIDENTS_SERVICE'

export type GatewayRoute = {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    path: string
    binding: GatewayBinding
}

const resourceRoutes = (
    collection: 'tasks' | 'incidents',
    binding: GatewayBinding
): GatewayRoute[] => {
    const collectionPath = `/livequery/${collection}`
    const documentPath = `${collectionPath}/:id`

    return [
        { method: 'GET', path: collectionPath, binding },
        { method: 'POST', path: collectionPath, binding },
        { method: 'GET', path: documentPath, binding },
        { method: 'PUT', path: documentPath, binding },
        { method: 'PATCH', path: documentPath, binding },
        { method: 'DELETE', path: documentPath, binding },
    ]
}

export const GATEWAY_ROUTES: readonly GatewayRoute[] = [
    ...resourceRoutes('tasks', 'TASKS_SERVICE'),
    ...resourceRoutes('incidents', 'INCIDENTS_SERVICE'),
]

type CompiledRoute = GatewayRoute & { pattern: RegExp }

const escapeSegment = (segment: string): string =>
    segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const compilePath = (path: string): RegExp => {
    const segments = path.split('/').filter(Boolean)
    const source = segments
        .map(segment => segment.startsWith(':') ? '[^/]+' : escapeSegment(segment))
        .join('/')

    return new RegExp(`^/${source}/?$`)
}

const COMPILED_ROUTES: readonly CompiledRoute[] = GATEWAY_ROUTES.map(route => ({
    ...route,
    pattern: compilePath(route.path),
}))

export function matchGatewayRoute(method: string, pathname: string): GatewayRoute | undefined {
    const normalizedMethod = method.toUpperCase()
    return COMPILED_ROUTES.find(route =>
        route.method === normalizedMethod && route.pattern.test(pathname)
    )
}
