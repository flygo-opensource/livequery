import type { Hono, Handler, MiddlewareHandler } from 'hono'
import type { LivequeryRoute } from './types.js'
import { livequery, type LivequeryMiddlewareOptions } from './middleware.js'

export type HonoRouteMethod = 'get' | 'post' | 'put' | 'patch' | 'delete'

export class LivequeryRouteRegistry {
    readonly #routes: LivequeryRoute[] = []

    get routes(): LivequeryRoute[] {
        return [...this.#routes]
    }

    add(method: string, path: string): void {
        const normalized = normalizePath(path)
        const METHOD = method.toUpperCase()
        if (this.#routes.some(route => route.method === METHOD && route.path === normalized)) return
        this.#routes.push({ method: METHOD, path: normalized })
    }
}

export type LivequeryRouterOptions = LivequeryMiddlewareOptions

export class LivequeryRouter {
    readonly registry = new LivequeryRouteRegistry()

    constructor(
        readonly app: Hono,
        readonly options: LivequeryRouterOptions = {}
    ) {}

    get(path: string, ...handlers: Handler[]): void {
        this.#route('get', path, handlers)
    }

    post(path: string, ...handlers: Handler[]): void {
        this.#route('post', path, handlers)
    }

    put(path: string, ...handlers: Handler[]): void {
        this.#route('put', path, handlers)
    }

    patch(path: string, ...handlers: Handler[]): void {
        this.#route('patch', path, handlers)
    }

    delete(path: string, ...handlers: Handler[]): void {
        this.#route('delete', path, handlers)
    }

    use(path: string, ...handlers: MiddlewareHandler[]): void {
        this.app.use(path, ...handlers)
    }

    #route(method: HonoRouteMethod, path: string, handlers: Handler[]): void {
        this.registry.add(method, path)
        this.app[method](path, livequery({ ...this.options, routePath: path }), ...handlers)
    }
}

export function createLivequery(app: Hono, options: LivequeryRouterOptions = {}): LivequeryRouter {
    return new LivequeryRouter(app, options)
}

export function collectServicePaths(app: Hono): LivequeryRoute[] {
    return app.routes.map(route => ({
        method: route.method,
        path: normalizePath(route.path),
    }))
}

function normalizePath(path: string): string {
    return path.split('/').filter(Boolean).join('/')
}
