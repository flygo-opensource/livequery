import { applyDecorators, SetMetadata, UseInterceptors } from "@nestjs/common";
import { DatatasourceRouteMetadata, LivequeryDatasourceInterceptors } from "../LivequeryDatasourceInterceptors.js";
import { UseLivequeryInterceptor } from "../LivequeryInterceptor.js";
import { RouterOptions } from "express";
import { Observable } from 'rxjs'
import { ModuleRef } from "@nestjs/core";
import type { LivequeryDatasource, UpdatedData } from "@livequery/core";
import { WebsocketGateway } from "@livequery/core";

export type ResolverRoutes = Array<{
    path: string,
    options: RouterOptions
}>

// A datasource class is core's LivequeryDatasource (`handle` + `init`). `config` is
// assigned by the provider factory after DI construction, hence the optional property.
export type LivequeryDatasourceFactory<Config, RouteOptions> = {
    new(...args: any[]): LivequeryDatasource<RouteOptions> & { config?: Config }
}

export type LivequeryDatasourceWatcherRoute<RouteOptions> = {
    path: string
    schema: string
    method: string
    options: RouteOptions
}

export type LivequeryDatasourceWatcher<Config, RouteOptions> = {
    watch(
        config: Config,
        routes: Array<LivequeryDatasourceWatcherRoute<RouteOptions>>,
        ds: LivequeryDatasource<RouteOptions>
    ): Observable<UpdatedData<any>>
}

export type LivequeryDatasourceWatcherFactory<Config, RouteOptions> = {
    new(...args: any[]): LivequeryDatasourceWatcher<Config, RouteOptions>
}


export type CreateDatasourceOptions<Config, RouteOptions> = {
    querier: LivequeryDatasourceFactory<Config, RouteOptions>
    watcher?: LivequeryDatasourceWatcherFactory<Config, RouteOptions>
    injects?: any[]
    config: Config | ((...args: any[]) => Promise<Config> | Config)
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
        inject: [ModuleRef, WebsocketGateway, ...injects],
        useFactory: async (moduleRef: ModuleRef, ws: WebsocketGateway, ...injections: any[]) => {
            const ds = await moduleRef.create(querier)
            const interceptor = await moduleRef.create(LivequeryDatasourceInterceptors)
            const routes = interceptor.getRoutes<RouteOptions>(querier as unknown as Symbol)
            const config = configResolver instanceof Function ? await configResolver(...injections) : configResolver
            ds.config = config
            await ds.init(routes.map(r => ({ path: r.path, method: r.method, ...r.options })))
            if (watcher) {
                const w = await moduleRef.create(watcher)
                w.watch(config, routes, ds).subscribe({
                    next(value) {
                        ws.next(value)
                    },
                })
            }
            return ds
        }
    }


    return [decorator, provider] as [typeof decorator, typeof provider]
}
