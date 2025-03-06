import { applyDecorators, Provider, UseInterceptors } from "@nestjs/common";
import { LivequeryDatasourceInterceptors, $__datasource_factory_token } from "../LivequeryDatasourceInterceptors.js";
import { UseLivequeryInterceptor } from "../LivequeryInterceptor.js";
import { PathHelper } from "./PathHelper.js";
import { Observable } from "rxjs";
import { LivequeryRequest, WebsocketSyncPayload } from "@livequery/types";
import { LivequeryWebsocketSync } from "../LivequeryWebsocketSync.js";

export type LivequeryDatasourceOptions<T> = Array<T & { refs: string[] }>

export type LivequeryDatasourceProps<OptionsType = {}, RawDataChangeType = {}, InjectType = any> = {
    routes: LivequeryDatasourceOptions<OptionsType>,
    deps: { [name: string]: InjectType }
    rawChanges: Observable<RawDataChangeType>
}

export type LivequeryDatasource<OptionsType = {}, RawDataChangeType = {}, InjectType = any> = {
    init(props: LivequeryDatasourceProps<OptionsType, RawDataChangeType, InjectType>)
    query(query: LivequeryRequest): any
    $: Observable<WebsocketSyncPayload>
}

export const createDatasourceMapper = <OptionsType = {}, RawDataChangeType = {}, InjectType = any>(
    factory: { new(): LivequeryDatasource<OptionsType, RawDataChangeType, InjectType> },
    injectTokens: { [name: string]: any },
    rawChanges: Observable<RawDataChangeType>
) => {


    const RouteConfigList: Array<{
        options: OptionsType
        target: any,
        method: string
    }> = [];

    const decorator = (options: OptionsType) => applyDecorators(
        (target, method) => RouteConfigList.push({
            method,
            options,
            target
        }),
        UseLivequeryInterceptor(),
        UseInterceptors(LivequeryDatasourceInterceptors),
        (_target, _method, descriptor: PropertyDescriptor) => {
            Reflect.defineMetadata($__datasource_factory_token, factory, descriptor.value)
        }
    )

    const provider: Provider = {
        provide: factory,
        inject: [{ token: LivequeryWebsocketSync, optional: true }, ...Object.values(injectTokens)],
        useFactory: async (ws: LivequeryWebsocketSync, ...injects) => {
            const deps = Object.keys(injectTokens).reduce((acc, key, i) => ({ ...acc, [key]: injects[i] }), {})
            const ds = new factory()
            const routes = RouteConfigList.map(({ method, options, target }) => {
                const refs = PathHelper.join(
                    Reflect.getMetadata('path', target.constructor),
                    Reflect.getMetadata('path', target[method])
                ).map(PathHelper.trimLivequeryHotkey)
                return {
                    ...options,
                    refs
                }
            })
            await ds.init({
                deps,
                rawChanges,
                routes
            })
            ds.$.subscribe(d => ws.broadcast(d))
            return ds
        }
    }


    return [decorator, provider] as [typeof decorator, typeof provider]
} 