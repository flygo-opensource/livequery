import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map, mergeMap, Subject } from 'rxjs';
import { DiscoveryService, ModuleRef, Reflector } from '@nestjs/core'
import { LivequeryBaseEntity, LivequeryRequest, WebsocketSyncPayload } from '@livequery/types';
import { hidePrivateFields } from './helpers/hidePrivateFields.js';
import { PathHelper } from './helpers/PathHelper.js';


export class LivequeryItemMapper<T extends LivequeryBaseEntity> {
    constructor(public readonly mapper: (item: T) => T) { }
}



export type LivequeryDatasource<Config, RouteOptions> = Subject<WebsocketSyncPayload<LivequeryBaseEntity>> & {
    init(config: Config, routes: Array<{ path: string, method: number, options: RouteOptions }>): Promise<void>
    query: (query: LivequeryRequest, options: RouteOptions) => Promise<any>
}

export type DatatasourceRouteMetadata<RouteOptions> = {
    datasource: Symbol,
    options: RouteOptions
}


@Injectable()
export class LivequeryDatasourceInterceptors implements NestInterceptor {


    constructor(
        private reflector: Reflector,
        private readonly discovery: DiscoveryService,
        private moduleRef: ModuleRef
    ) { }


    getRoutes<Options>(token?: Symbol) {
        const controllers = this.discovery.getControllers()
        return controllers.map(controller => {
            const names = Object.getOwnPropertyNames(controller.metatype.prototype) || []
            return names.map(name => {
                const fn = controller.metatype.prototype[name]
                const metadata = this.reflector.get(LivequeryDatasourceInterceptors, fn) as DatatasourceRouteMetadata<Options>
                if (!metadata || (token && metadata.datasource != token)) return []
                const cpaths = [Reflect.getMetadata('path', controller.metatype)].flat(2)
                const mpaths = [Reflect.getMetadata('path', fn)].flat(2)
                const paths = cpaths.map(a => mpaths.map(b => {
                    const x = (a || '').trim().replace(/^\/+|\/+$/g, '')
                    const y = (b || '').trim().replace(/^\/+|\/+$/g, '')
                    const joined = (x == '' || y == '') ? `${x}${y}` : `${x}/${y}`
                    const { ref } = PathHelper.parseHttpRequestPath(joined)
                    return ref
                })).flat(2)
                const method = Reflect.getMetadata('method', controller.metatype.prototype[name])
                return paths.map(path => ({
                    path,
                    options: metadata.options,
                    method
                }))
            })
        }).flat(2)
    }


    async intercept(ctx: ExecutionContext, next: CallHandler) {
        return next.handle().pipe(
            mergeMap(async rs => {
                const req = ctx.switchToHttp().getRequest()
                const { options, datasource } = await this.reflector.get(LivequeryDatasourceInterceptors, ctx.getHandler()) as (
                    DatatasourceRouteMetadata<{}>
                )
                const ds = await this.moduleRef.get(datasource as any) as LivequeryDatasource<any, any>
                const lrs = await ds.query(req.livequery, options)
                if (rs instanceof LivequeryItemMapper) {
                    if (lrs.item) {
                        return {
                            ...lrs,
                            item: rs.mapper(lrs.item)
                        }
                    }

                    if (lrs.items) {
                        return {
                            ...lrs,
                            items: lrs.items.map(item => rs.mapper(item))
                        }
                    }
                    return lrs
                }

                if (typeof rs == 'function') {
                    return await rs(lrs)
                }
                return rs || lrs
            }),
            map(data => {
                if (data.items) {
                    return {
                        ...data,
                        items: data.items.map(item => hidePrivateFields(item))
                    }
                }
                return data
            })
        )

    }
}
