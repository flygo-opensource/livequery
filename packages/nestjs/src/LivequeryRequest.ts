import { createParamDecorator, ExecutionContext } from "@nestjs/common";

export const LivequeryRequestKey = 'livequery'

export const LivequeryRequest = createParamDecorator((data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest()
    return request[LivequeryRequestKey]
})