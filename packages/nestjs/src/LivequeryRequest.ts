import { createParamDecorator, ExecutionContext } from "@nestjs/common";


export const LivequeryRequest = createParamDecorator((data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest()
    return request.__livequery_request
})