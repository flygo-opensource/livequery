import type { LivequeryFilter } from "./LivequeryCore";
import type { LivequeryDocument } from "./LivequeryTransporter";


export type LivequeryStorge = {
    query<T extends LivequeryDocument>(
        collection: string,
        filters?: Record<string, any>
    ): Promise<T[]>
    add<T extends LivequeryDocument>(collection: string, document: T): Promise<T>
    update<T extends LivequeryDocument>(collection: string, id: string, document: Partial<T>): Promise<T | null>
    delete<T extends LivequeryDocument>(collection: string, id: string): Promise<T | null>
    // export database method
    // import database method
    // switch database method
}