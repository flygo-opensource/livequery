import type { Context, Handler } from 'hono'
import { Observable, Subject, Subscription } from 'rxjs'
import { hidePrivateFields, LivequeryRequestParser, type LivequeryDatasourceInitConfig } from '@livequery/core'
import type { LivequeryBaseEntity, LivequeryRequest, UpdatedData, WebsocketSyncPayload } from '@livequery/core'
import { getLivequeryRequest } from './request.js'
import { livequeryJson } from './response.js'
import type { LivequeryRoute, LivequeryResponse } from './types.js'
import type { LivequeryRouteRegistry } from './route-registry.js'
import { WebsocketGateway } from '@livequery/core'

export class LivequeryItemMapper<T extends LivequeryBaseEntity> {
    constructor(public readonly mapper: (item: T) => T) {}
}

export type LivequeryDatasource<RouteOptions> = Subject<WebsocketSyncPayload<LivequeryBaseEntity>> & {
    init(routes: Array<LivequeryDatasourceInitConfig<RouteOptions>>): Promise<void>
    query(query: LivequeryRequest, options: RouteOptions): Promise<{ items?: any[]; item?: any }>
}

export type LivequeryDatasourceRoute<RouteOptions> = LivequeryRoute & {
    /** Per-route datasource options; required for the route to be watched in realtime. */
    options?: RouteOptions
}

export type LivequeryWatcherRoute<RouteOptions> = {
    path: string
    method: string
    /** Parsed route path from @livequery/core (document-id segment stripped), e.g. 'users/:userId/posts'. */
    schema: string
    options: RouteOptions
}

export type LivequeryDatasourceWatcher<Config, RouteOptions> = {
    watch(
        config: Config,
        routes: Array<LivequeryWatcherRoute<RouteOptions>>,
        ds: LivequeryDatasource<RouteOptions>
    ): Observable<UpdatedData<any>>
}

export type CreateDatasourceOptions<Config, RouteOptions> = {
    datasource: LivequeryDatasource<RouteOptions>
    watcher?: LivequeryDatasourceWatcher<Config, RouteOptions>
    websocketGateway?: WebsocketGateway
    routes: Array<LivequeryDatasourceRoute<RouteOptions>> | LivequeryRouteRegistry
    config?: Config | Promise<Config>
}

function parseRouteSchema(path: string): string | undefined {
    try {
        const normalized = path.split('/').filter(Boolean).join('/')
        return LivequeryRequestParser.parse({
            ref: normalized,
            path: normalized,
            params: {},
            query: {},
            method: 'GET',
            headers: new Map(),
        })?.schema
    } catch {
        return undefined
    }
}

export async function createDatasourceMapper<Config, RouteOptions>(
    options: CreateDatasourceOptions<Config, RouteOptions>
) {
    const routes: Array<LivequeryDatasourceRoute<RouteOptions>> =
        Array.isArray(options.routes) ? options.routes : options.routes.routes
    const datasourceRoutes = routes.map(route => ({
        path: route.path,
        method: route.method,
        ...(route.options ?? {}),
    })) as Array<LivequeryDatasourceInitConfig<RouteOptions>>

    await options.datasource.init(datasourceRoutes)

    let realtime: Subscription | undefined
    if (options.watcher && options.websocketGateway) {
        const config = (await options.config) as Config
        const watcherRoutes = routes.flatMap<LivequeryWatcherRoute<RouteOptions>>(route => {
            if (!route.options) return []
            const schema = parseRouteSchema(route.path)
            if (!schema) return []
            return [{ path: route.path, method: route.method, schema, options: route.options }]
        })
        realtime = options.watcher.watch(config, watcherRoutes, options.datasource).subscribe({
            next: value => options.websocketGateway?.next(value),
        })
    }

    const useDatasource = (routeOptions: RouteOptions, mapper?: DatasourceMapper): Handler => {
        return async c => {
            const livequeryRequest = getLivequeryRequest(c)
            try {
                const result = await options.datasource.query(livequeryRequest as any, routeOptions)
                return livequeryJson(c, mapDatasourceResult(c, result, mapper))
            } catch (e: any) {
                // Datasources throw structured `{ status, code, message }` errors (e.g. a
                // 400 for a malformed cursor / ObjectId). Map them to the HTTP response
                // instead of letting them bubble up as an opaque 500.
                const status = typeof e?.status === 'number' ? e.status : 500
                return c.json({ error: { code: e?.code ?? 'INTERNAL', message: e?.message ?? 'Internal error' } }, status as any)
            }
        }
    }

    // `realtime` exposes the watcher subscription so callers can tear it down on shutdown.
    return Object.assign(useDatasource, { realtime })
}

export type DatasourceMapper =
    | LivequeryItemMapper<any>
    | ((result: { items?: any[]; item?: any }, c: Context) => LivequeryResponse | Promise<LivequeryResponse>)

function mapDatasourceResult(
    c: Context,
    result: { items?: any[]; item?: any },
    mapper?: DatasourceMapper
): LivequeryResponse {
    if (mapper instanceof LivequeryItemMapper) {
        if (result.item) return { ...result, item: mapper.mapper(result.item) }
        if (result.items) return { ...result, items: result.items.map(item => mapper.mapper(item)) }
        return result
    }

    if (typeof mapper === 'function') {
        const mapped = mapper(result, c)
        if (mapped instanceof Promise) {
            throw new Error('Async datasource mapper must be awaited by a custom Hono handler')
        }
        return mapped
    }

    if (result.items) {
        return { ...result, items: result.items.map(item => hidePrivateFields(item)) }
    }

    return result
}
