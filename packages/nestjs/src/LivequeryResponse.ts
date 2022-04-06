import { createParamDecorator, ExecutionContext } from "@nestjs/common";

export type LivequeryResponse<T = any> = {
    items: T[],
    page_info?: {
        has_more: boolean
    }
}

export const LivequeryResponse = createParamDecorator(
    (data: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().livequery_response
)