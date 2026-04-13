import { Observable, BehaviorSubject } from "rxjs";
import type { DataChangeEvent } from '@livequery/core';
export type LivequerySocketMetadata = {
    client_id: string;
    gateway_id?: string;
    connected: boolean;
    session: number;
};
export declare class Socket extends BehaviorSubject<LivequerySocketMetadata> {
    #private;
    private endpoint;
    readonly client_id: string;
    readonly $gateway: BehaviorSubject<{
        id: string;
    } | undefined>;
    readonly $connected: BehaviorSubject<boolean>;
    constructor(endpoint: string);
    stop(): void;
    private $sync;
    private $hello;
    subscribeWith(realtime_token: string): void;
    listen(ref: string): Observable<DataChangeEvent>;
}
//# sourceMappingURL=Socket.d.ts.map