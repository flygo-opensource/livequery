import { applyDecorators, SetMetadata, UseInterceptors } from "@nestjs/common";
import { DatatasourceRouteMetadata, LivequeryDatasourceInterceptors, LivequeryDatasourceOptions } from "../LivequeryDatasourceInterceptors.js";
import { UseLivequeryInterceptor } from "../LivequeryInterceptor.js";


export const createDatasourceMapper = <Config, RouteOptions>(
    { config, resolver, watcher }: LivequeryDatasourceOptions<Config, RouteOptions>
) => (options: RouteOptions) => {
    const metadata: DatatasourceRouteMetadata<Config, RouteOptions> = {
        options,
        resolver 
    }
    LivequeryDatasourceInterceptors.setConfig(resolver, {
        config,
        resolver,
        watcher
    })
    return applyDecorators(
        UseLivequeryInterceptor(),
        UseInterceptors(LivequeryDatasourceInterceptors),
        SetMetadata(LivequeryDatasourceInterceptors, metadata)
    )
}