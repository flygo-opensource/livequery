import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map, mergeMap, Observable } from 'rxjs';
import { ModuleRef } from '@nestjs/core'
import { LivequeryDatasource } from './helpers/createDatasourceMapper.js';
import { LivequeryBaseEntity } from '@livequery/types';
import { hidePrivateFields } from './helpers/hidePrivateFields.js';



export const LivequeryDatasourceList = new Map<{ new(...args): LivequeryDatasource }, LivequeryDatasource>()
export const $__datasource_factory_token = Symbol()

export class LivequeryItemMapper<T extends LivequeryBaseEntity> {
    constructor(public readonly mapper: (item: T) => T) { }
}

@Injectable()
export class LivequeryDatasourceInterceptors implements NestInterceptor {

    constructor(private moduleRef: ModuleRef) { }

    async intercept(ctx: ExecutionContext, next: CallHandler) {

        const token = Reflect.getMetadata($__datasource_factory_token, ctx.getHandler())
        const datasource = LivequeryDatasourceList.has(token) ? LivequeryDatasourceList.get(token) : this.moduleRef.get(token)


        return next.handle().pipe(
            mergeMap(async rs => {
                const req = ctx.switchToHttp().getRequest()
                const lrs = await datasource.query(req.livequery)

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
