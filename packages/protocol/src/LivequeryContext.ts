export type CollectionResponse<T> = {
    items: T[]
    paging: {
        current: number
        total: number
    }
    cursor: {
        current: string
        next: string
        prev: string
    }
}

export type DocumentResponse<T> = {
    item: T
}

export type LivequeryRequest<T = any> = {
    ref: string
    keys: Record<string, any>
    collection_ref?: string
    schema_collection_ref?: string
    method: string
    body?: T
    // Raw fields produced by LivequeryRequestParser.
    path?: string
    collection?: string
    schema?: string
    document_id?: string
    query?: Record<string, any>
    // Custom action verb parsed from a `~verb` suffix in the path (undefined when absent).
    action?: string
    // Set during request normalization by datasource adapters.
    is_collection?: boolean
}

export type RawRequest = {
    path: string
    ref: string
    method: string
    body?: any
    params: Record<string, any>
    query: Record<string, any>
    headers: Map<string, string>
}

export type LivequeryContext<T = {}> = {
    request: RawRequest
    livequery?: LivequeryRequest<any>
    response?: T
}

export type LivequeryHandler<O = {}> = {
    handle(ctx: LivequeryContext<O>): any
}

