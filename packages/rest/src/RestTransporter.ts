import { Transporter, QueryOption, QueryStream, QueryData, CollectionResponse, DocumentResponse, Response as ApiResponse, TransporterHook } from '@livequery/types'
import { of, firstValueFrom } from 'rxjs';
import { catchError, map, mergeMap } from 'rxjs/operators';
import { merge, pipe,tap } from 'rxjs'
import { Socket } from './Socket.js';
import qs from 'query-string'


type MaybePromise<T> = T | Promise<T>

export type ApiRequest = { url: RequestInfo | URL | string, options?: RequestInit }


export type RestTransporterConfig = {
    base_url: () => MaybePromise<string>
    websocket_url?: () => MaybePromise<string>,
}


export class RestTransporter implements Transporter {

    private socket: Socket

    constructor(
        private config: RestTransporterConfig
    ) {
        config.websocket_url && (this.socket = new Socket(config.websocket_url))
    }

    hook(hook: TransporterHook): RestTransporter {

        return {
            ...this,

            hook: (next_hook: TransporterHook) => {
                return this.hook(next => pipe(hook(() => next_hook(next))))
            },

            get: <T>(ref: string, query: any = {}) => {
                return this.call<T>(ref, 'GET', null, query, hook)
            },

            add: <T extends {} = {}>(ref: string, data: Partial<T>): Promise<any> => {
                return this.call(ref, 'POST', data, {}, hook)
            },

            update: <T extends {} = {}>(ref: string, data: Partial<T>, method: 'PATCH' | 'PUT' = 'PATCH'): Promise<any> => {
                return this.call(ref, method, data, {}, hook)
            },

            remove: <T>(ref: string) => {
                return this.call<T>(ref, 'DELETE', {}, {}, hook)
            },

            trigger: <T>(ref: string, name: string, payload?: any, query?: any) => {
                return this.call<ApiResponse<T>>(`${ref}/~${name}`, 'POST', payload, query, hook)
            },

            query: <T extends { id: string }>(ref: string, options?: Partial<QueryOption<T>>) => {
                return this.#query(ref, options, hook)
            }, 
        }
    }

    query<T extends { id: string }>(ref: string, options?: Partial<QueryOption<T>>) {
        return this.#query(ref, options)
    }

    #query<T extends { id: string }>(ref: string, options?: Partial<QueryOption<T>>, hook?: TransporterHook) {

        const http_request = merge(of(1), this.socket?.$reconnect || of<void>())
            .pipe(
                mergeMap(() => this.call<QueryData<T>>(ref, 'GET', undefined, options, hook)),
                map(({ data, error }) => {
                    if (error) throw error
                    data.subscription_token && this.socket?.subscribe(data.subscription_token)

                    const collection = data as CollectionResponse<T>['data']

                    // If collection
                    if (collection.items) {
                        return {
                            data: {
                                changes: collection.items.map(data => ({ data, type: 'added', ref })),
                                paging: { ...collection, n: 0 }
                            }
                        } as QueryStream<T>
                    }

                    // If document  
                    const document = data as DocumentResponse<T>['data']
                    return {
                        data: {
                            changes: [{ data: document.item, type: 'added', ref }],
                            paging: { ...collection, n: 0 }
                        }
                    } as QueryStream<T>

                }),
                catchError(error => of({ error })),
            )

        const websocket_sync = (!this.socket || options[':after'] || options[':before'] || options[':around']) ? of<QueryStream<T>>() : (
            this.socket.listen(ref).pipe(
                map((change) => ({ data: { changes: [change] } } as QueryStream<T>))
            )
        )

        return merge(http_request, websocket_sync)
    }

    private async call<Response extends {}>(url: string, method: string, payload?: any, query: any = {}, hook?: TransporterHook): Promise<Response> {
        function encode_query(query: any) {

            if (!query || Object.keys(query || {}).length == 0) return ''

            const encoded_query = Object.keys(query).reduce((o, key) => ({
                ...o,
                [key]: typeof query[key] == 'object' ? JSON.stringify(query[key]) : query[key]
            }), {})

            return `?${qs.stringify(encoded_query)}`
        }

        const headers = {
            ...payload ? {
                'Content-Type': 'application/json'
            } : {},
            ... this.socket ? { socket_id: this.socket.socket_session } : {}
        }

        try {
            const request: ApiRequest = {
                url: `${this.config.base_url()}/${url}${encode_query(query)}`,
                options: {
                    method,
                    headers: headers as any,
                    ...payload ? { body: JSON.stringify(payload) } : {},
                }
            }
            const next = () => pipe(
                mergeMap(async (mapped: ApiRequest) => {
                    const response = await fetch(mapped.url, mapped.options).then(r => r.json())
                    return {
                        ...response,
                        __request: mapped
                    }
                })
            )
            const body: any = await firstValueFrom(of(request).pipe(
                hook ? hook(next) : next()
            ))
            if (body.error) throw body.error
            return body as Response
        } catch (error) {
            throw error
        }
    }

    get<T>(ref: string, query: any = {}) {
        return this.call<T>(ref, 'GET', null, query,)
    }

    add<T extends {} = {}>(ref: string, data: Partial<T>): Promise<any> {
        return this.call(ref, 'POST', data, {})
    }

    update<T extends {} = {}>(ref: string, data: Partial<T>, method: 'PATCH' | 'PUT' = 'PATCH'): Promise<any> {
        return this.call(ref, method, data, {})
    }

    remove<T>(ref: string) {
        return this.call<T>(ref, 'DELETE')
    }

    trigger<T extends {}>(ref: string, name: string, payload?: any, query?: any) {
        return this.call<ApiResponse<T>>(`${ref}/~${name}`, 'POST', payload, query)
    }
} 