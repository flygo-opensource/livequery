import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { LivequeryRequest as LQR } from '@livequery/core'


export const LivequeryRequest = createParamDecorator((data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest()
    return request.livequery
})


export type LivequeryRequest = LQR 