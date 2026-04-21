import type { Doc, LivequeryTransporter, LivequeryResult, LivequeryPaging, LivequeryQueryResult, LivequeryAction, LivequeryFilters } from '@livequery/core';
export type RestTransporterRequest = {
    url: string;
    method: string;
    query?: Record<string, any>;
    body?: Record<string, any> | string;
    headers?: Record<string, string | undefined>;
};
export type Promiseable<T> = T | Promise<T>;
export type RestTransporterConfig = {
    api: string;
    ws?: string;
    onRequest?: (options: RestTransporterRequest & {
        ref: string;
    }) => Promiseable<Partial<RestTransporterRequest & {
        response?: LivequeryResult<any>;
    }>> | void;
    onResponse?: (request: RestTransporterRequest & {
        ref: string;
    }, response: LivequeryResult<any>) => Promise<void> | void;
};
export type LivequeryCollectionResponse<T extends Doc> = {
    summary?: any;
    items: T[];
    item: T;
    subscription_token?: string;
    paging: LivequeryPaging;
};
export declare class RestTransporter implements LivequeryTransporter {
    #private;
    private config;
    private socket;
    constructor(config: RestTransporterConfig);
    query<T extends Doc>({ ref, filters }: {
        ref: string;
        filters: LivequeryFilters<T>;
    }): import("rxjs").Observable<Partial<LivequeryQueryResult>>;
    add<T extends Doc>(ref: string, data: Partial<Omit<T, 'id'>>): Promise<T>;
    update<T extends Doc>(collection_ref: string, id: string, data: Partial<T>): Promise<T>;
    delete<T extends Doc>(collection_ref: string, id: string): Promise<T>;
    trigger<T>({ ref, action, payload }: LivequeryAction): Promise<T>;
}
//# sourceMappingURL=RestTransporter.d.ts.map