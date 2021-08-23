import { LivequeryRequest, QueryData, QueryOption } from '@livequery/types';
import { applyDecorators, CallHandler, ExecutionContext, Injectable, NestInterceptor, UseInterceptors } from '@nestjs/common'
import { ModuleRef } from '@nestjs/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

const DataSourceMetadataKey = Symbol()

export type Datasource = {
    query(query: LivequeryRequest): Promise<QueryData>
}

@Injectable()
export class UseDataSourceInterceptor implements NestInterceptor {

    constructor(private moduleRef: ModuleRef) { }

    async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {

        const datasource_factory = Reflect.getMetadata(
            DataSourceMetadataKey,
            context.getClass().prototype,
            context.getHandler().name
        )
        const datasource = await this.moduleRef.get<Datasource>(datasource_factory)

        const req = context.switchToHttp().getRequest()
        const livequery: LivequeryRequest = req.__livequery_request
        const livequery_response = await datasource.query(livequery)
        req.__livequery_response = livequery_response

        return next.handle().pipe(
            map(response => {
                if (response == undefined) return livequery_response
                return response
            })
        )
    }
}

export const UseDatasource = (datasource: { new(): Datasource }) => applyDecorators(
    Reflect.metadata(DataSourceMetadataKey, datasource),
    UseInterceptors(UseDataSourceInterceptor)
)

