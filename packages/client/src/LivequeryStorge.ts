import type { LivequeryDocument, LivequeryPaging } from "./types"



export type LivequeryStorge = {
    query<T extends LivequeryDocument>(
        collection: string,
        filters?: Record<string, any>
    ): Promise<{
        documents: T[]
        paging: LivequeryPaging
    }>
    get<T extends LivequeryDocument>(ref: string, id: string): Promise<T | null>
    add<T extends LivequeryDocument>(collection: string, document: T): Promise<T>
    update<T extends LivequeryDocument>(collection: string, id: string, document: Record<string, any>): Promise<T | null>
    delete<T extends LivequeryDocument>(collection: string, id: string): Promise<T | null>
}