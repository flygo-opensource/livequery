import { LivequeryRequest } from "@livequery/types"
import { applyDecorators, CallHandler, ExecutionContext, Injectable, SetMetadata, UseInterceptors } from "@nestjs/common"
import { ModuleRef, Reflector } from "@nestjs/core"
import { LivequeryInterceptor } from "./LivequeryInterceptor"
import { LivequeryRequestKey } from "./LivequeryRequest"
import { PathHelper } from "./PathHelper"
import { map } from "rxjs"

type Datasource = {
    query(req: LivequeryRequest): Promise<any>
}


@Injectable()
export class UseDatasource {

    public static readonly UseDatasourceMetadata = Symbol()
    private static ControllerList: Array<{ target: Function, method: string, options }> = []


    constructor(
        private moduleRef: ModuleRef,
        private reflector: Reflector
    ) { }

    static createDatasourceMapper<T>(factory: { new(): Datasource }) {

        const decorator = (options: T) => applyDecorators(
            UseInterceptors(LivequeryInterceptor),
            UseInterceptors(this),
            SetMetadata(this.UseDatasourceMetadata, { options, factory }),
            (target, method) => this.ControllerList.push({
                target: target.constructor,
                method,
                options
            })
        )

        const list = () => this.ControllerList.map(({ method, target, options }) => {
            const paths = PathHelper.nestjsPathResolver(target, method).map(path => {
                return PathHelper.livequeryPathExtractor(path)
            })
            return { paths, options: options as T }
        }).flat(2)

        return [decorator, list] as [typeof decorator, typeof list]
    }

    async intercept(context: ExecutionContext, next: CallHandler) {
        const request = context.switchToHttp().getRequest()
        const livequery = request[LivequeryRequestKey]
        const { factory } = this.reflector.get(UseDatasource.UseDatasourceMetadata, context.getHandler())
        const ds = await this.moduleRef.get<Datasource>(factory)
        const result = await ds.query(livequery)
        return next.handle().pipe(
            map(data => data ?? result)
        )
    }
}
