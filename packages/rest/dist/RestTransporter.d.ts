import type { Doc, LivequeryTransporter, LivequeryResult, LivequeryQueryResult, LivequeryAction, LivequeryFilters } from '@livequery/client';
export type RestTransporterRequest = Omit<RequestInit, 'body' | 'headers'> & {
    url: string;
    query?: Record<string, any>;
    body?: BodyInit | Record<string, any> | null;
    headers?: HeadersInit;
};
export type Promiseable<T> = T | Promise<T>;
export type RestTransporterConfig = {
    api: string;
    ws?: string;
    credentials?: RequestCredentials;
    onRequest?: (options: RestTransporterRequest & {
        ref: string;
        context?: Record<string, any>;
    }) => Promiseable<Partial<RestTransporterRequest & {
        response?: LivequeryResult<any>;
    }>> | void;
    onResponse?: (request: RestTransporterRequest & {
        ref: string;
    }, response: LivequeryResult<any>) => Promise<void> | void;
};
export type LivequeryCollectionResponse<T extends Doc> = {
    summary?: any;
    items?: T[];
    item?: T;
    subscription_token?: string;
    count?: {
        prev: number;
        next: number;
        total: number;
        current: number;
    };
    has?: {
        prev: boolean;
        next: boolean;
    };
    cursor?: {
        first: string;
        last: string;
    };
};
export declare class RestTransporter implements LivequeryTransporter {
    #private;
    private config;
    private socket;
    constructor(config: RestTransporterConfig);
    query<T extends Doc>({ ref, filters, headers, context }: {
        ref: string;
        filters?: Partial<LivequeryFilters<T>>;
        headers?: HeadersInit;
        context?: Record<string, any>;
    }): import("rxjs").Observable<Partial<LivequeryQueryResult>>;
    add<T extends Doc>(ref: string, data: Partial<Omit<T, 'id'>>, context?: Record<string, any>): Promise<T>;
    update<T extends Doc>(collection_ref: string, id: string, data: Partial<T>, context?: Record<string, any>): Promise<T>;
    delete<T extends Doc>(collection_ref: string, id: string, context?: Record<string, any>): Promise<T>;
    trigger<T>({ ref, action, payload, context }: LivequeryAction): Promise<T>;
}
//# sourceMappingURL=RestTransporter.d.ts.map