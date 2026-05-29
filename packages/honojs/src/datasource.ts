import type { Context, Handler } from 'hono'
import { Observable, Subject } from 'rxjs'
import { hidePrivateFields, type LivequeryDatasourceInitConfig } from '@livequery/core'
import type { LivequeryBaseEntity, LivequeryRequest, UpdatedData, WebsocketSyncPayload } from '@livequery/types'
import { getLivequeryRequest } from './request.js'
import { livequeryJson } from './response.js'
import type { LivequeryRoute, LivequeryResponse } from './types.js'
import type { LivequeryRouteRegistry } from './route-registry.js'
import { WebsocketGateway } from '@livequery/core'

export class LivequeryItemMapper<T extends LivequeryBaseEntity> {
    constructor(public readonly mapper: (item: T) => T) {}
}

export type LivequeryDatasource<Config, RouteOptions> = Subject<WebsocketSyncPayload<LivequeryBaseEntity>> & {
    init(config: Config, routes: Array<LivequeryDatasourceInitConfig<RouteOptions>>): Promise<void>
    query(query: LivequeryRequest, options: RouteOptions): Promise<{ items?: any[]; item?: any }>
}

export type LivequeryDatasourceWatcher<Config, RouteOptions> = {
    watch(
        config: Config,
        routes: Array<LivequeryDatasourceInitConfig<RouteOptions>>,
        ds: LivequeryDatasource<Config, RouteOptions>
    ): Observable<UpdatedData<any>>
}

export type CreateDatasourceOptions<Config, RouteOptions> = {
    datasource: LivequeryDatasource<Config, RouteOptions>
    watcher?: LivequeryDatasourceWatcher<Config, RouteOptions>
    websocketGateway?: WebsocketGateway
    routes: LivequeryRoute[] | LivequeryRouteRegistry
    config: Config | Promise<Config>
}

export async function createDatasourceMapper<Config, RouteOptions>(
    options: CreateDatasourceOptions<Config, RouteOptions>
) {
    const routes = Array.isArray(options.routes) ? options.routes : options.routes.routes
    const config = await options.config
    const datasourceRoutes = routes.map(route => ({
        path: route.path,
        method: route.method,
        config: undefined as RouteOptions,
    }))

    await options.datasource.init(config, datasourceRoutes)

    if (options.watcher && options.websocketGateway) {
        options.watcher.watch(config, datasourceRoutes, options.datasource).subscribe({
            next: value => options.websocketGateway?.next(value),
        })
    }

    return function useDatasource(routeOptions: RouteOptions, mapper?: DatasourceMapper): Handler {
        return async c => {
            const livequeryRequest = getLivequeryRequest(c)
            const result = await options.datasource.query(livequeryRequest, routeOptions)
            return livequeryJson(c, mapDatasourceResult(c, result, mapper))
        }
    }
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
