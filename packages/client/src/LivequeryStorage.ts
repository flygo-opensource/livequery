import type { Doc, DocState, LivequeryPaging } from "./types.js"

export type LivequeryStorage = {
    query<T extends Doc>(
        collection: string,
        filters?: Record<string, any>
    ): Promise<{
        documents: T[]
        paging: LivequeryPaging
    }>
    get<T extends Doc>(ref: string, id: string): Promise<T | null>
    add<T extends Doc>(collection: string, document: Partial<DocState<T>>): Promise<DocState<T>>
    update<T extends Doc>(collection: string, id: string, document: Record<string, any>): Promise<DocState<T> | null>
    delete<T extends Doc>(collection: string, id: string): Promise<DocState<T> | null>
    flush(): Promise<void>
    /**
     * Set by adapters whose data is visible to more than one context at once (IndexedDB is shared
     * by every tab of an origin). Contexts that see the same value elect a single outbox drainer
     * through `navigator.locks`, so a queued write is not sent twice.
     */
    readonly shared?: string
}
