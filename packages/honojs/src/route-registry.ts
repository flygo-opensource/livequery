import type { Env, Hono, Handler, MiddlewareHandler } from 'hono'
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

export type LivequeryRouterOptions<E extends Env = any> = LivequeryMiddlewareOptions<E>

export class LivequeryRouter<E extends Env = any> {
    readonly registry = new LivequeryRouteRegistry()

    constructor(
        readonly app: Hono<E>,
        readonly options: LivequeryRouterOptions<E> = {}
    ) {}

    get(path: string, ...handlers: Handler<E>[]): void {
        this.#route('get', path, handlers)
    }

    post(path: string, ...handlers: Handler<E>[]): void {
        this.#route('post', path, handlers)
    }

    put(path: string, ...handlers: Handler<E>[]): void {
        this.#route('put', path, handlers)
    }

    patch(path: string, ...handlers: Handler<E>[]): void {
        this.#route('patch', path, handlers)
    }

    delete(path: string, ...handlers: Handler<E>[]): void {
        this.#route('delete', path, handlers)
    }

    use(path: string, ...handlers: MiddlewareHandler<E>[]): void {
        this.app.use(path, ...handlers)
    }

    #route(method: HonoRouteMethod, path: string, handlers: Handler<E>[]): void {
        this.registry.add(method, path)
        this.app[method](path, livequery({ ...this.options, routePath: path }), ...handlers)
    }
}

export function createLivequery<E extends Env = any>(
    app: Hono<E>,
    options: LivequeryRouterOptions<E> = {}
): LivequeryRouter<E> {
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
