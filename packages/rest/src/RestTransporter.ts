import { of, firstValueFrom, EMPTY } from 'rxjs';
import { filter, map, mergeMap } from 'rxjs/operators';
import { merge } from 'rxjs'
import { Socket } from './Socket.js';
import { Doc, LivequeryTransporter, LivequeryResult, LivequeryPaging, LivequeryQueryResult, LivequeryAction, LivequeryFilters } from '@livequery/new'
import { MaybePromise } from './DeduplicateComposer.js';

export type RestTransporterRequest = {
    ref: string
    action?: string
    method: string
    payload?: any
    query?: any
    context?:any 
}

export type RestTransporterConfig = {
    api: string
    ws?: string
    headers?: (options: RestTransporterRequest) => MaybePromise<Record<string, string>>
    onRequest?: (options: RestTransporterRequest) => Promise<void>
    onResponse?: (request: RestTransporterRequest, response: LivequeryResult<any>) => Promise<void>
}



export type LivequeryCollectionResponse<T extends Doc> = {
    summary?: any,
    items: T[],
    item: T
    subscription_token?: string,
    paging: LivequeryPaging
}


export class RestTransporter implements LivequeryTransporter<any> {

    private socket: Socket | undefined

    constructor(
        private config: RestTransporterConfig
    ) {
        if (config.ws) {
            this.socket = new Socket(config.ws!)
        }
    }

    async #call<T>({ method, ref, payload, query }: RestTransporterRequest) {
        const url = `${await this.config.api}/${ref}${Object.keys(query || {}).length > 0 ? `?${new URLSearchParams(query).toString()}` : ''}`
        const headers = {
            ...payload ? {
                'Content-Type': 'application/json'
            } : {},
            ... this.socket ? {
                socket_id: this.socket.client_id,
                'x-lcid': this.socket.client_id,
                'x-lgid': await firstValueFrom(this.socket.$gateway.pipe(
                    filter(Boolean),
                    map(g => g.id)
                ))
            } : {}
        }
        const req = { method, ref, payload, query }
        this.config.onRequest && await this.config.onRequest(req)
        const response: LivequeryResult<T> = await fetch(url, {
            method,
            headers,
            ...payload ? { body: JSON.stringify(payload) } : {},
        }).then(r => r.json())
        this.config.onResponse && await this.config.onResponse(req, response)
        if (response.error) throw response.error
        return response.data
    }

    query<T extends Doc>({ ref, filters }: { ref: string, filters: LivequeryFilters<T> }) {
        const http_request = merge(this.socket?.$reconnect || of(1)).pipe(
            mergeMap(() => this.#call<LivequeryCollectionResponse<T>>({ ref, method: 'GET', payload: undefined, query: filters })),
            map(collection => {
                collection.subscription_token && this.socket?.subscribe(collection.subscription_token)

                // If collection
                if (collection.items) {
                    return {
                        summary: collection.summary,
                        changes: collection.items.map(data => ({ data, type: 'added', id: data.id })),
                        source: "query"
                    } as Partial<LivequeryQueryResult>
                }

                // If document  
                return {
                    summary: collection.summary,
                    changes: [{ data: collection.item, type: 'added', id: collection.item.id }],
                    source: "query"
                } as Partial<LivequeryQueryResult>

            })
        )


        const websocket_sync = (!this.socket || !filters || filters[':after'] || filters[':before'] || filters[':around']) ? EMPTY : (
            this.socket.listen(ref).pipe(
                map((change) => {
                    const e: Partial<LivequeryQueryResult> = {
                        changes: [change],
                        source: "realtime"
                    }
                    return e
                })
            )
        )

        return merge(http_request, websocket_sync)
    }

    add<T extends Doc>( ref: string, data: Partial<Omit<T, 'id'>>) {
        return this.#call<T>({ method: 'POST', ref, payload: data, query: {} })
    }

    update<T extends Doc>(ref: string, id: string, data: Partial<T>) {
        return this.#call<T>({ method: 'PATCH', ref: ref + '/' + id, payload: data, query: {} })
    }

    delete<T extends Doc>(ref: string, id: string) {
        return this.#call<T>({ method: 'DELETE', ref: ref + '/' + id, payload: undefined, query: {} })
    }


    trigger<T>( { ref, action, payload }: LivequeryAction) {
        return this.#call<T>({ method: 'POST', ref, action, payload, query: {} })
    }
}
 