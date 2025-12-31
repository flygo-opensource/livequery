import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map, mergeMap, Observable } from 'rxjs';
import { DiscoveryService, ModuleRef, Reflector } from '@nestjs/core'
import { LivequeryBaseEntity, LivequeryRequest, WebsocketSyncPayload } from '@livequery/types';
import { hidePrivateFields } from './helpers/hidePrivateFields.js';
import { LivequeryWebsocketSync } from './LivequeryWebsocketSync.js';


export class LivequeryItemMapper<T extends LivequeryBaseEntity> {
    constructor(public readonly mapper: (item: T) => T) { }
}



export type LivequeryDatasource<Config, RouteOptions> = Observable<WebsocketSyncPayload<LivequeryBaseEntity>> & {
    init?: (config: Config, options: Array<{ path: string, options: RouteOptions }>) => Promise<void>
    query?: (query: LivequeryRequest, config: Config, options: RouteOptions) => any
}

export type LivequeryDatasourceFactory<Config, RouteOptions> = {
    new(...args: any[]): LivequeryDatasource<Config, RouteOptions>
}

export type LivequeryDatasourceOptions<Config, RouteOptions> = {
    resolver: LivequeryDatasourceFactory<Config, RouteOptions>
    watcher?: LivequeryDatasourceFactory<Config, RouteOptions>
    config: (r: <T = any>(token: string | symbol) => Promise<T>) => Promise<Config>
}

export type DatatasourceRouteMetadata<Config, RouteOptions> = {
    options: RouteOptions
    resolver: LivequeryDatasourceFactory<Config, RouteOptions>
}



@Injectable()
export class LivequeryDatasourceInterceptors implements NestInterceptor {

    private static configs = new Map<LivequeryDatasourceFactory<any, any>, LivequeryDatasourceOptions<any, any>>()
    #configs = new Map<LivequeryDatasourceFactory<any, any>, any>()

    constructor(
        private reflector: Reflector,
        private ws: LivequeryWebsocketSync,
        private readonly discovery: DiscoveryService,
        private moduleRef: ModuleRef
    ) { }


    static setConfig(
        factory: LivequeryDatasourceFactory<any, any>,
        config: LivequeryDatasourceOptions<any, any>
    ) {
        this.configs.set(factory, config)
    }


    async onModuleInit() {
        const controllers = this.discovery.getControllers()

        const resources = new Map<
            LivequeryDatasourceFactory<any, any>,
            Array<{ path: string, options: any }>
        >()

        for (const controller of controllers) {
            const methods = Object.getOwnPropertyNames(controller.metatype.prototype) || []
            for (const method of methods) {
                const fn = controller.metatype.prototype[method]
                const options = this.reflector.get(LivequeryDatasourceInterceptors, fn) as DatatasourceRouteMetadata<{}, {}>
                if (!options) continue
                const cpaths = [Reflect.getMetadata('path', controller.metatype)].flat(2)
                const mpaths = [Reflect.getMetadata('path', fn)].flat(2)
                const paths = cpaths.map(a => mpaths.map(b => {
                    const x = (a || '').trim().replace(/^\/+|\/+$/g, '')
                    const y = (b || '').trim().replace(/^\/+|\/+$/g, '')
                    if (x == '' || y == '') return `${x}${y}`
                    return `${x}/${y}`
                })).flat(2)

                for (const path of paths) {
                    const list = resources.get(options.resolver) || []
                    list.push({ path, options: options.options })
                    resources.set(options.resolver, list)
                }
            }
        }

        console.log({resources})

        for (const [resolver, routes] of resources) {
            const $ = LivequeryDatasourceInterceptors.configs.get(resolver)
            if (!$) continue
            const config = await $.config(token => this.moduleRef.get(token))
            for (const f of [resolver, $.watcher]) {
                if (!f) continue
                const ds = await this.moduleRef.create(f) as LivequeryDatasource<any, any>
                this.ws.link(ds) 
                await ds.init(config, routes)
            }
        }
    }

    async intercept(ctx: ExecutionContext, next: CallHandler) {
        return next.handle().pipe(
            mergeMap(async rs => {
                const req = ctx.switchToHttp().getRequest()
                const { options, resolver } = await this.reflector.get(LivequeryDatasourceInterceptors, ctx.getHandler()) as (
                    DatatasourceRouteMetadata<{}, {}>
                )
                const config = await this.#configs.get(resolver)
                const ds = req.livequeryDatasources.get(resolver)
                const lrs = await ds.query(req.livequery, config, options)
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
