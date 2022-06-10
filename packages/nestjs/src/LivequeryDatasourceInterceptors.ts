import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map } from 'rxjs';
import { LivequeryRequest } from '@livequery/types';
import { ModuleRef } from '@nestjs/core'
import { Console } from 'console';

export type DatasourceOptions<T> = Array<T & { refs: string[] }>
export type Datasource<T = any> = { query(query: LivequeryRequest): any }


export const DatasourceList = new Map<{ new(...args): Datasource }, Datasource>()
export const $__datasource_factory_token = Symbol()



@Injectable()
export class LivequeryDatasourceInterceptors implements NestInterceptor {

    constructor(private moduleRef: ModuleRef ) {   }

    async intercept(ctx: ExecutionContext, next: CallHandler) {

        const token = Reflect.getMetadata($__datasource_factory_token, ctx.getHandler())
        const datasource = DatasourceList.has(token) ? DatasourceList.get(token) : this.moduleRef.get(token)
        const req = ctx.switchToHttp().getRequest()
        req.livequery_response = await datasource.query(req.livequery)
        return next.handle().pipe(
            map(rs => rs ?? req.livequery_response)
        )
    }
}
