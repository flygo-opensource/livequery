import type { MiddlewareHandler } from 'hono'
import { WebsocketGateway } from '@livequery/core'
import { createLivequeryRequest } from './request.js'

export type LivequeryMiddlewareOptions = {
    websocketGateway?: WebsocketGateway
    routePath?: string
}

export function livequery(options: LivequeryMiddlewareOptions = {}): MiddlewareHandler {
    return async (c, next) => {
        const requestOptions = options.routePath ? { routePath: options.routePath } : {}
        const livequeryRequest = await createLivequeryRequest(c, requestOptions)
        c.set('livequery' as never, livequeryRequest as never)

        const ws = options.websocketGateway
        if (ws && c.req.method === 'GET' && livequeryRequest) {
            const client_id = c.req.header('x-lcid') || c.req.header('socket_id')
            const gateway_id = c.req.header('x-lgid') || ws.id
            const query = livequeryRequest.query ?? {}
            const has_cursor = !!(query[':after'] || query[':before'] || query[':around'])

            if (client_id && gateway_id && !has_cursor) {
                ws.listen([{
                    ref: livequeryRequest.ref,
                    client_id,
                    gateway_id,
                    listener_node_id: ws.id,
                }])
            }
        }

        await next()
    }
}
