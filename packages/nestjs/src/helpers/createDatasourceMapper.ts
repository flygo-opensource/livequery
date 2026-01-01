import { applyDecorators, SetMetadata, UseInterceptors } from "@nestjs/common";
import { DatatasourceRouteMetadata, LivequeryDatasource, LivequeryDatasourceInterceptors } from "../LivequeryDatasourceInterceptors.js";
import { UseLivequeryInterceptor } from "../LivequeryInterceptor.js";
import { RouterOptions } from "express";
import { Observable } from 'rxjs'
import { ModuleRef } from "@nestjs/core";
import { WebsocketSyncPayload } from "@livequery/types";
import { LivequeryWebsocketSync } from "../LivequeryWebsocketSync.js";

export type ResolverRoutes = Array<{
    path: string,
    options: RouterOptions
}>

export type LivequeryDatasourceFactory<Config, RouteOptions> = {
    new(...args: any[]): LivequeryDatasource<Config, RouteOptions>
}

export type LivequeryDatasourceWatcher<Config, RouteOptions> = {
    watch(
        config: Config,
        routes: Array<{ path: string, method: number, options: RouteOptions }>,
        ds: LivequeryDatasource<Config, RouteOptions>
    ): Observable<WebsocketSyncPayload<any>>
}

export type LivequeryDatasourceWatcherFactory<Config, RouteOptions> = {
    new(...args: any[]): LivequeryDatasourceWatcher<Config, RouteOptions>
}


export type CreateDatasourceOptions<Config, RouteOptions> = {
    querier: LivequeryDatasourceFactory<Config, RouteOptions>
    watcher?: LivequeryDatasourceWatcherFactory<Config, RouteOptions>
    injects?: any[]
    config?: Config | ((...args: any[]) => Promise<Config> | Config)
}

export const createDatasourceMapper = <Config, RouteOptions>({
    querier,
    injects = [],
    config: configResolver,
    watcher
}: CreateDatasourceOptions<Config, RouteOptions>) => {


    const decorator = (options: RouteOptions) => {
        const metadata: DatatasourceRouteMetadata<RouteOptions> = {
            options,
            datasource: querier as unknown as Symbol
        }
        return applyDecorators(
            UseLivequeryInterceptor(),
            UseInterceptors(LivequeryDatasourceInterceptors),
            SetMetadata(LivequeryDatasourceInterceptors, metadata)
        )
    }

    const provider = {
        provide: querier,
        inject: [ModuleRef, LivequeryWebsocketSync, ...injects],
        useFactory: async (moduleRef: ModuleRef, ws: LivequeryWebsocketSync, ...injections: any[]) => {
            const ds = await moduleRef.create<LivequeryDatasource<Config, RouteOptions>>(querier)
            const interceptor = await moduleRef.create<LivequeryDatasourceInterceptors>(LivequeryDatasourceInterceptors)
            const routes = interceptor.getRoutes<RouteOptions>(querier as unknown as Symbol)
            const config = configResolver instanceof Function ? await configResolver(...injections) : configResolver
            await ds.init(config, routes)
            if (watcher) {
                const w = await moduleRef.create<LivequeryDatasourceWatcher<Config, RouteOptions>>(watcher)
                ws.link(w.watch(config, routes, ds))
            }
            return ds
        }
    }


    return [decorator, provider] as [typeof decorator, typeof provider]
}