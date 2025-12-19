import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map, mergeMap } from 'rxjs';
import { ModuleRef, Reflector } from '@nestjs/core'
import { LivequeryBaseEntity } from '@livequery/types';
import { hidePrivateFields } from './helpers/hidePrivateFields.js';
import { DatatasourceConnectionMetadata } from './helpers/createDatasourceMapper.js';
import { LivequeryWebsocketSync } from './LivequeryWebsocketSync.js';


export class LivequeryItemMapper<T extends LivequeryBaseEntity> {
    constructor(public readonly mapper: (item: T) => T) { }
}

@Injectable()
export class LivequeryDatasourceInterceptors implements NestInterceptor {

    constructor(
        private moduleRef: ModuleRef,
        private reflector: Reflector,
        private ws: LivequeryWebsocketSync
    ) { }

    async intercept(ctx: ExecutionContext, next: CallHandler) {

        return next.handle().pipe(
            mergeMap(async rs => {
                const req = ctx.switchToHttp().getRequest()
                const { factory, options } = await this.reflector.get(LivequeryDatasourceInterceptors, ctx.getHandler()) as {
                    factory: Function
                    options: DatatasourceConnectionMetadata
                }
                const datasource = await this.moduleRef.get(factory)
                this.ws.link(datasource)
                const connection_token = typeof options.connection === 'function' ? await options.connection(req.livequery) : options.connection
                const connection = await this.moduleRef.get(connection_token, { strict: false })
                const lrs = await datasource.query(req.livequery, options, connection)

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
