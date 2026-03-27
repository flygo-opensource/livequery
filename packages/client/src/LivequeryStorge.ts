import type { LivequeryQueryFilter } from "./LivequeryCollection";
import type { LivequeryDocument } from "./LivequeryTransporter";


export type LivequeryStorge = {
    query<T extends LivequeryDocument>(
        collection: string,
        filters: Record<string, LivequeryQueryFilter>
    ): Promise<T[]>
    add<T extends LivequeryDocument>(collection: string, document: T): Promise<T>
    update<T extends LivequeryDocument>(collection: string, id: string, document: Partial<T>): Promise<T | null>
    delete<T extends LivequeryDocument>(collection: string, id: string): Promise<T | null>
}