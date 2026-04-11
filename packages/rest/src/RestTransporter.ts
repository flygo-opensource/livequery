import { of, firstValueFrom, EMPTY, from } from 'rxjs';
import { filter, first, map, mergeMap, shareReplay, take, tap } from 'rxjs/operators';
import { merge } from 'rxjs'
import { Socket } from './Socket.js';
import type { Doc, LivequeryTransporter, LivequeryResult, LivequeryPaging, LivequeryQueryResult, LivequeryAction, LivequeryFilters } from '@livequery/new'


export type RestTransporterRequest = {
    url: string
    method: string
    query?: Record<string, any>
    body?: Record<string, any> | string
    headers?: Record<string, string | undefined>
}

export type Promiseable<T> = T | Promise<T>

export type RestTransporterConfig = {
    api: string
    ws?: string
    onRequest?: (options: RestTransporterRequest & { ref: string }) => Promiseable<Partial<RestTransporterRequest & { response?: LivequeryResult<any> }>> | void
    onResponse?: (request: RestTransporterRequest & { ref: string }, response: LivequeryResult<any>) => Promise<void> | void
}



export type LivequeryCollectionResponse<T extends Doc> = {
    summary?: any,
    items: T[],
    item: T
    subscription_token?: string,
    paging: LivequeryPaging
}


export class RestTransporter implements LivequeryTransporter {

    private socket: Socket | undefined

    constructor(
        private config: RestTransporterConfig
    ) {
        if (config.ws) {
            this.socket = new Socket(config.ws!)
        }
    }

    async #call<T>(req: Omit<RestTransporterRequest, 'url'> & { ref: string, action?: string }) {
        const url = `${await this.config.api}/${req.ref}${req.action ? `/~${req.action}` : ''}${Object.keys(req.query || {}).length > 0 ? `?${new URLSearchParams(req.query).toString()}` : ''}`
        const base_headers = {
            ...req.body ? {
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
        const original_request: RestTransporterRequest & { ref: string } = {
            url,
            method: req.method,
            body: req.body,
            headers: base_headers,
            query: req.query,
            ref: req.ref
        }
        const { response: fake_response, headers, ...modified } = await this.config.onRequest?.(original_request) || {}
        if (fake_response) {
            this.config.onResponse && await this.config.onResponse(original_request, fake_response)
            if (fake_response.error) throw fake_response.error
            return fake_response.data as T
        }
        const request = {
            ref: req.ref,
            url,
            method: req.method,
            ...modified as any as {},
            headers: {
                ...base_headers,
                ...headers
            },
        }
        const response: LivequeryResult<T> = fake_response ? fake_response : await fetch(request.url, request).then(r => r.json())
        this.config.onResponse && await this.config.onResponse(request, response)
        if (response.error) throw response.error
        return response.data
    }

    query<T extends Doc>({ ref, filters }: { ref: string, filters: LivequeryFilters<T> }) {
        const ready$ = from(this.socket ? (this.socket.pipe(filter(s => !!s.connected), map(() => Date.now()))) : of(1)).pipe(first())
        const watch$ = (!this.socket || !filters || filters[':after'] || filters[':before'] || filters[':around']) ? EMPTY : this.socket.listen(ref)

        return merge(

            ready$.pipe(
                take(1),
                mergeMap(() => this.#call<LivequeryCollectionResponse<T>>({
                    ref,
                    method: 'GET',
                    query: filters
                })),
                map(collection => {
                    collection.subscription_token && this.socket?.subscribeWith(collection.subscription_token)
                    // If collection
                    if (collection.items) return {
                        summary: collection.summary,
                        changes: collection.items.map(data => ({ data, type: 'added', id: data.id })),
                        source: "query"
                    } as Partial<LivequeryQueryResult>

                    // If document  
                    return {
                        summary: collection.summary,
                        changes: [{ data: collection.item, type: 'added', id: collection.item.id }],
                        source: "query"
                    } as Partial<LivequeryQueryResult>

                })
            ),

            watch$.pipe(map((change) => {
                const e: Partial<LivequeryQueryResult> = {
                    changes: [change],
                    source: "realtime"
                }
                return e
            }))
        )
    }

    add<T extends Doc>(ref: string, data: Partial<Omit<T, 'id'>>) {
        return this.#call<T>({ method: 'POST', ref, body: data, query: {} })
    }

    update<T extends Doc>(ref: string, id: string, data: Partial<T>) {
        return this.#call<T>({ method: 'PATCH', ref: ref + '/' + id, body: data, query: {} })
    }

    delete<T extends Doc>(ref: string, id: string) {
        return this.#call<T>({ method: 'DELETE', ref: ref + '/' + id, body: undefined, query: {} })
    }


    trigger<T>({ ref, action, payload }: LivequeryAction) {
        return this.#call<T>({ method: 'POST', ref, action, body: payload, query: {} })
    }
}
