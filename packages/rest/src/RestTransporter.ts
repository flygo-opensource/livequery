import { Transporter, QueryOption, QueryStream, QueryData, CollectionResponse, DocumentResponse, Response } from '@livequery/types'
import { of } from 'rxjs';
import { catchError, finalize, map, mergeMap, tap } from 'rxjs/operators';
import { merge, Subject } from 'rxjs'
import { Socket } from './Socket.js';
import qs  from 'query-string'


type MaybePromise<T> = T | Promise<T>

export type RestTransporterConfig = {
    websocket_url: () => MaybePromise<string>,
    base_url: () => MaybePromise<string>,
    headers?: () => Promise<{ [key: string]: string }>
    onResponse?: (data: { url: string, headers: Headers, body: any, status: number }) => void
}

export class RestTransporter implements Transporter {

    private socket: Socket

    constructor(
        private config: RestTransporterConfig
    ) {
        config.websocket_url && (this.socket = new Socket(config.websocket_url))
    }


    query<T extends { id: string }>(ref: string, options?: Partial<QueryOption<T>>) {
        const $on_reload = new Subject<void>();
        const http_request = merge(of(1), this.socket?.$reconnect || of<void>(), $on_reload)
            .pipe(
                mergeMap(() => this.call<QueryData<T>>(ref, 'GET', undefined, options)),
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

        return Object.assign(
            merge(http_request, websocket_sync),
            {
                reload: () => $on_reload.next()
            }
        )
    }

    #encode_query(query: any) {

        if (!query || Object.keys(query || {}).length == 0) return ''

        const encoded_query = Object.keys(query).reduce((o, key) => ({
            ...o,
            [key]: typeof query[key] == 'object' ? JSON.stringify(query[key]) : query[key]
        }), {})

        return `?${qs.stringify(encoded_query)}`
    }

    private async call<Response extends {}>(url: string, method: string, payload?: any,query: any = {}): Promise<Response> {

        const headers = {
            ... await this.config.headers?.() || {},
            ...payload ? {
                'Content-Type': 'application/json'
            } : {},
            ... this.socket ? { socket_id: this.socket.socket_session } : {}
        }

        try {
            const response = await fetch(`${this.config.base_url()}/${url}${this.#encode_query(query)}`, {
                method,
                headers: headers as any,
                ...payload ? { body: JSON.stringify(payload) } : {},
            })

            try {
                const body = await response.json()
                this.config.onResponse?.({
                    body,
                    headers: response.headers,
                    status: response.status,
                    url
                })
                return body as Response
            } catch (e) {
                this.config.onResponse?.({
                    body: null,
                    headers: response.headers,
                    status: response.status,
                    url
                })
                return null
            }
        } catch (error) {
            throw error
        }
    }

    get<T>(ref: string, query: any = {}) {
        return this.call<T>(ref, 'GET',  null,query,)
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
        return this.call<Response<T>>(`${ref}/~${name}`, 'POST', payload, query)
    }
}