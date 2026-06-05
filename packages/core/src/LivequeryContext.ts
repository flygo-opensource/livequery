
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

export type LivequeryRequest<I> = {
    keys: Record<string, any>
    path: string
    document_id?: string
    collection_ref: string
    schema_collection_ref: string
    ref: string
    method: string
    body: I
    query: Record<string, any>
    // Custom action verb parsed from a `~verb` suffix in the path (undefined when absent).
    action?: string
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
