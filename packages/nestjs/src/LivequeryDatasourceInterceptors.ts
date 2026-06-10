import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor, RequestMethod } from '@nestjs/common';
import { map, mergeMap } from 'rxjs';
import { DiscoveryService, ModuleRef, Reflector } from '@nestjs/core'
import type { LivequeryBaseEntity, LivequeryContext, LivequeryDatasource } from '@livequery/core';
import { hidePrivateFields, LivequeryRequestParser } from '@livequery/core';


export class LivequeryItemMapper<T extends LivequeryBaseEntity> {
    constructor(public readonly mapper: (item: T) => T) { }
}

export type DatatasourceRouteMetadata<RouteOptions> = {
    datasource: Symbol,
    options: RouteOptions
}

@Injectable()
export class LivequeryDatasourceInterceptors implements NestInterceptor {


    // Explicit @Inject tokens (instead of relying on emitDecoratorMetadata's
    // design:paramtypes) so the class also works under transpilers that don't
    // emit decorator metadata (bun, esbuild, vite).
    constructor(
        @Inject(Reflector) private reflector: Reflector,
        @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
        @Inject(ModuleRef) private moduleRef: ModuleRef
    ) { }


    getRoutes<Options>(token?: Symbol) {
        const controllers = this.discovery.getControllers()
        return controllers.map(controller => {
            const metatype = controller.metatype
            if (!metatype) return []
            const names = Object.getOwnPropertyNames(metatype.prototype) || []
            return names.map(name => {
                const fn = metatype.prototype[name]
                const metadata = this.reflector.get(LivequeryDatasourceInterceptors, fn) as DatatasourceRouteMetadata<Options>
                if (!metadata || (token && metadata.datasource != token)) return []
                const cpaths = [Reflect.getMetadata('path', metatype)].flat(2)
                const mpaths = [Reflect.getMetadata('path', fn)].flat(2)
                const paths = cpaths.map(a => mpaths.map(b => {
                    const x = (a || '').trim().replace(/^\/+|\/+$/g, '')
                    const y = (b || '').trim().replace(/^\/+|\/+$/g, '')
                    const joined = (x == '' || y == '') ? `${x}${y}` : `${x}/${y}`
                    return LivequeryRequestParser.parse({
                        ref: joined,
                        path: joined,
                        params: {},
                        query: {},
                        method: 'GET',
                        headers: new Map(),
                    })?.schema ?? ''
                })).flat(2)
                // NestJS stores the HTTP verb as a RequestMethod enum number; datasources key
                // their route tables by verb string, so map it back to its name ('GET', ...).
                const method = RequestMethod[Reflect.getMetadata('method', metatype.prototype[name]) ?? RequestMethod.GET] ?? 'GET'
                return paths.map(path => ({
                    path,
                    schema: path,
                    options: metadata.options,
                    method
                }))
            })
        }).flat(2)
    }


    async intercept(ctx: ExecutionContext, next: CallHandler) {
        return next.handle().pipe(
            mergeMap(async (rs: { items?: any[], item?: any } | Function) => {
                const req = ctx.switchToHttp().getRequest()
                const { datasource } = this.reflector.get(LivequeryDatasourceInterceptors, ctx.getHandler()) as (
                    DatatasourceRouteMetadata<{}>
                )
                const ds = this.moduleRef.get(datasource as any) as LivequeryDatasource<any>

                // Drive the datasource through core's engine entry point (`handle`) with a
                // LivequeryContext rebuilt from the express request. `req.livequery` was set
                // by LivequeryInterceptor's parser; `ref` is the parsed schema, which matches
                // the route keys the datasource registered at init() time (getRoutes uses the
                // same parser on the controller route patterns).
                const context: LivequeryContext = {
                    request: {
                        path: req.originalUrl ?? req.url ?? '',
                        ref: req.livequery?.schema ?? req.route?.path ?? req.path ?? '',
                        params: req.params ?? {},
                        query: req.query ?? {},
                        body: req.body,
                        method: req.method,
                        headers: new Headers(req.headers as HeadersInit) as unknown as Map<string, string>,
                    },
                    livequery: req.livequery,
                }
                const lrs = await ds.handle(context) as { items?: any[], item?: any }

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
                    return await rs(lrs) as { items?: any[], item?: any }
                }
                return rs || lrs
            }),
            map(data => {
                if (data.items) {
                    return {
                        ...data,
                        items: data.items.map((item: any) => hidePrivateFields(item))
                    }
                }
                return data
            })
        )

    }
}
