import type { Context } from 'hono'
import type { LivequeryRequest } from '@livequery/core'

export type LivequeryVariables = {
    livequery: LivequeryRequest<unknown>
}

export type LivequeryContext = Context<{ Variables: LivequeryVariables }>

export type LivequeryRoute = {
    method: string
    path: string
}

export type LivequeryResponse<T = unknown> = {
    item?: T
    items?: T[]
    [key: string]: unknown
}
