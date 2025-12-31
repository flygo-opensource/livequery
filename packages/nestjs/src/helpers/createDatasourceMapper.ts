import { applyDecorators, SetMetadata, UseInterceptors } from "@nestjs/common";
import { LivequeryDatasource, LivequeryDatasourceInterceptors } from "../LivequeryDatasourceInterceptors.js";
import { UseLivequeryInterceptor } from "../LivequeryInterceptor.js";
import { RouterOptions } from "express";
import { ModuleRef } from "@nestjs/core";

export type ResolverRoutes = Array<{ path: string, options: RouterOptions }>

export type Options<RouteOptions> = {
    injects?: any[],
    resolver: (...injections: any[]) => Promise<LivequeryDatasource<RouteOptions>> | LivequeryDatasource<RouteOptions>
}

export const createDatasourceMapper = <Config, RouteOptions>(config: Options<RouteOptions>) => {


    const decorator = (options: RouteOptions) => applyDecorators(
        UseLivequeryInterceptor(),
        UseInterceptors(LivequeryDatasourceInterceptors),
        SetMetadata(LivequeryDatasourceInterceptors, { datasource: config.resolver, options })
    )

    const provider = {
        provide: config.resolver,
        inject: [ModuleRef,  ...config.injects || []],
        useFactory: async (moduleRef: ModuleRef, ...injections: any[]) => {
            const lqdi =await  moduleRef.create<LivequeryDatasourceInterceptors>(LivequeryDatasourceInterceptors)
            const routes = lqdi.getRoutes<RouteOptions>(config.resolver as unknown as Symbol)
            const factory = await config.resolver(...injections) 
            await factory.init(routes)
            return factory
        }
    }


    return [decorator, provider] as [typeof decorator, typeof provider]
}