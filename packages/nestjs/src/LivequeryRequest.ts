import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import { LivequeryRequest as LQR } from '@livequery/types'


export const LivequeryRequest = createParamDecorator((data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest()
    return request.livequery
})


export type LivequeryRequest = LQR 