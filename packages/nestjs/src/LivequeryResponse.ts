import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import { QueryData, Response } from '@livequery/types'

export const LivequeryResponse = createParamDecorator((data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest()
    return request.__livequery_response
})


export const createLivequeryResponse = <T>(items: T[]) => {
    return {
        data: {
            items
        },
        error: null
    } as QueryData<T>
}