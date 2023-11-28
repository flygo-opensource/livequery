import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map } from 'rxjs';
import { ModuleRef } from '@nestjs/core'
import { LivequeryDatasource } from './helpers/createDatasourceMapper.js';







export const LivequeryDatasourceList = new Map<{ new(...args): LivequeryDatasource }, LivequeryDatasource>()
export const $__datasource_factory_token = Symbol()



@Injectable()
export class LivequeryDatasourceInterceptors implements NestInterceptor {

    constructor(private moduleRef: ModuleRef) { }

    async intercept(ctx: ExecutionContext, next: CallHandler) {

        const token = Reflect.getMetadata($__datasource_factory_token, ctx.getHandler())
        const datasource = LivequeryDatasourceList.has(token) ? LivequeryDatasourceList.get(token) : this.moduleRef.get(token)
        const req = ctx.switchToHttp().getRequest()
        req.livequery_response = await datasource.query(req.livequery)
        return next.handle().pipe(
            map(rs => rs ?? req.livequery_response)
        )
    }
}
