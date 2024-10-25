import { applyDecorators, Provider, UseInterceptors } from "@nestjs/common";
import { LivequeryDatasourceInterceptors, $__datasource_factory_token } from "../LivequeryDatasourceInterceptors.js";
import { UseLivequeryInterceptor } from "../LivequeryInterceptor.js";
import { PathHelper } from "./PathHelper.js";
import { merge, Observable } from "rxjs";
import { LivequeryRequest, WebsocketSyncPayload } from "@livequery/types";
import { LivequeryWebsocketSync } from "../LivequeryWebsocketSync.js";

export type LivequeryDatasourceOptions<T> = Array<T & { refs: string[] }>


export type LivequeryDatasource<Options = {}, StreamPayload = {}, Connection = any> = {
    init(routes: LivequeryDatasourceOptions<Options>, connections: { [name: string]: Connection }): Promise<void>
    query(query: LivequeryRequest): any
    enable_realtime?: (stream: Observable<StreamPayload>) => Observable<WebsocketSyncPayload>
}




export const createDatasourceMapper = <Options, StreamPayload, Connection>(
    factory: { new(): LivequeryDatasource<Options, StreamPayload, Connection> },
    inject_tokens: { [connection_name: string]: any },
    ...observables: Array<Observable<StreamPayload>>
) => {

    const observable = merge(...observables)

    const RouteConfigList: Array<{ target: any, method: string, options: Options }> = [];

    const decorator = (options: Options) => applyDecorators(
        (target, method) => RouteConfigList.push({ target, method, options }),
        UseLivequeryInterceptor(),
        UseInterceptors(LivequeryDatasourceInterceptors),
        (_target, _method, descriptor: PropertyDescriptor) => {
            Reflect.defineMetadata($__datasource_factory_token, factory, descriptor.value)
        }
    )



    const getDatasourceMetadatas = () => RouteConfigList.map(config => {
        return {
            ...(config.options || {}) as Options,
            refs: PathHelper.join(
                Reflect.getMetadata('path', config.target.constructor),
                Reflect.getMetadata('path', config.target[config.method])
            ).map(PathHelper.trimLivequeryHotkey)
        }
    })

    const provider: Provider = {
        provide: factory,
        inject: [{ token: LivequeryWebsocketSync, optional: true }, ...Object.values(inject_tokens)],
        useFactory: async (ws: LivequeryWebsocketSync, ... injects) => {
            const ds = new factory()
            const map = Object.keys(inject_tokens).reduce((acc, key, i) => ({ ...acc, [key]: injects[i] }), {})
            await ds.init(getDatasourceMetadatas(), map)
            ws && ds.enable_realtime?.(observable).subscribe(
                change => ws.broadcast(change)
            )
            return ds
        }
    }


    return [decorator, provider] as [typeof decorator, typeof provider]
} 