import { applyDecorators, Provider, UseInterceptors } from "@nestjs/common";
import { LivequeryDatasourceInterceptors, $__datasource_factory_token } from "../LivequeryDatasourceInterceptors.js";
import { UseLivequeryInterceptor } from "../LivequeryInterceptor.js";
import { PathHelper } from "./PathHelper.js";
import { merge, Observable } from "rxjs";
import { LivequeryRequest, WebsocketSyncPayload } from "@livequery/types";
import { LivequeryWebsocketSync } from "../LivequeryWebsocketSync.js";

export type LivequeryDatasourceOptions<T> = Array<T & { refs: string[] }>

export type LivequeryDatasource<Options = {}, StreamPayload = {}, InjectList extends Array<any> = undefined> = {
    init(routes: LivequeryDatasourceOptions<Options>, injects: InjectList): Promise<void>
    query(query: LivequeryRequest): any
    enable_realtime?: (stream: Observable<StreamPayload>) => Observable<WebsocketSyncPayload>
}




export const createDatasourceMapper = <Options, StreamPayload, InjectList extends Array<any> = undefined>(
    factory: { new(): LivequeryDatasource<Options, StreamPayload, InjectList> },
    inject_tokens: Array<symbol | string | any> = [],
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
        inject: [LivequeryWebsocketSync, ...inject_tokens],
        useFactory: async (ws: LivequeryWebsocketSync, ...injects: InjectList) => {
            const ds = new factory()
            await ds.init(getDatasourceMetadatas(), injects)
            ds.enable_realtime?.(observable).subscribe(
                change => ws.broadcast(change)
            )
            return ds
        }
    }


    return [decorator, provider] as [typeof decorator, typeof provider]
} 