import { LivequeryRequest } from '@livequery/types'
import { PathHelper } from './helpers/PathHelper.js'
import { RealtimeSubscription } from './LivequeryWebsocketSync.js'

export type HttpRequestContext = {
    pathname: string
    routePath: string
    query: Record<string, any>
    params: Record<string, any>
    body?: any
    method: string
}

export function parseLivequeryHttpRequest(ctx: HttpRequestContext): LivequeryRequest {
    const { ref, is_collection, collection_ref, doc_id } = PathHelper.parseHttpRequestPath(ctx.pathname)
    const { collection_ref: schema_collection_ref } = PathHelper.parseHttpRequestPath(ctx.routePath)

    return {
        ref,
        is_collection,
        collection_ref,
        schema_collection_ref,
        doc_id: doc_id ?? undefined,
        keys: ctx.params,
        options: ctx.query,
        body: ctx.body,
        method: ctx.method.toLowerCase()
    }
}

export function extractRealtimeSubscription(
    ref: string,
    headers: Record<string, string | string[] | undefined>,
    query: Record<string, any>,
    nodeId: string,
    gatewayId?: string
): RealtimeSubscription | null {
    const client_id = headers['x-lcid'] as string | undefined || headers['socket_id'] as string | undefined
    const gateway_id = headers['x-lgid'] as string | undefined || gatewayId
    const has_cursor = !!(query[':after'] || query[':before'] || query[':around'])

    if (!client_id || !gateway_id || has_cursor) return null

    return { ref, client_id, gateway_id, listener_node_id: nodeId }
}
