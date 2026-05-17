import type { Doc, DocState, LivequeryPaging } from "./types.js"



export type LivequeryStorge = {
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
}