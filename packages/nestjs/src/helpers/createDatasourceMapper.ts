import { applyDecorators, UseInterceptors } from "@nestjs/common";
import { Datasource, LivequeryDatasourceInterceptors, $__datasource_factory_token } from "../LivequeryDatasourceInterceptors.js";
import { UseLivequeryInterceptor } from "../LivequeryInterceptor.js";
import { PathHelper } from "./PathHelper.js";



export const createDatasourceMapper = <T extends {}>(datasource_factory: { new(...args): Datasource }) => {


    const RouteConfigList: Array<{ target: any, method: string, options: T }> = [];



    const decorator = (options: T) => applyDecorators(
        (target, method) => RouteConfigList.push({ target, method, options }),
        UseLivequeryInterceptor(),
        UseInterceptors(LivequeryDatasourceInterceptors),
        (target, method, descriptor: PropertyDescriptor) => {
            Reflect.defineMetadata($__datasource_factory_token, datasource_factory, descriptor.value)
        }
    )



    const getDatasourceMetadatas = () => RouteConfigList.map(config => {
        return {
            ...(config.options || {}) as T,
            refs: PathHelper.join(
                Reflect.getMetadata('path', config.target.constructor),
                Reflect.getMetadata('path', config.target[config.method])
            ).map(PathHelper.trimLivequeryHotkey)
        }
    })

    return [decorator, getDatasourceMetadatas] as [typeof decorator, typeof getDatasourceMetadatas]
}