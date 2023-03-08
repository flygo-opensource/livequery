import { Transporter, QueryOption, QueryStream, QueryData, CollectionResponse, DocumentResponse } from '@livequery/types'
import { of } from 'rxjs';
import { catchError, finalize, map, mergeMap, tap } from 'rxjs/operators';
import { merge, Subject } from 'rxjs'
import { Socket } from './Socket';
import { stringify } from 'query-string'


type MaybePromise<T> = T | Promise<T>

export type RestTransporterConfig = {
    websocket_url: () => MaybePromise<string>,
    base_url: () => MaybePromise<string>,
    headers?: () => Promise<{ [key: string]: string }>
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
                mergeMap(() => this.call<any, null, QueryData<T>>(ref, 'GET', options)),
                map(({ data, error }) => {
                    if (error) throw error
                    data.realtime_token && this.socket?.subscribe(data.realtime_token)

                    // If collection
                    const collection = data as CollectionResponse<T>['data']
                    if (collection.items) {
                        return {
                            data: {
                                changes: collection.items.map(data => ({ data, type: 'added', ref })),
                                paging: { ...collection.paging, n: 0 }
                            }
                        } as QueryStream<T>
                    }

                    // If document  
                    const document = data as DocumentResponse<T>['data']
                    return {
                        data: {
                            changes: [{ data: document.item, type: 'added', ref }],
                            paging: { n: 0 }
                        }
                    } as QueryStream<T>

                }),
                catchError(error => of({ error })),
            )

        const websocket_sync = (!this.socket || options._cursor) ? of<QueryStream<T>>() : (
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

        return `?${stringify(encoded_query)}`
    }

    private async call<Query = any, Payload = any, Response = void>(url: string, method: string, query: Query = {} as Query, payload?: Payload): Promise<Response> {

        const headers = {
            ... await this.config.headers?.() || {},
            ...payload ? {
                'Content-Type': 'application/json'
            } : {},
            ... this.socket ? { socket_id: this.socket.socket_session } : {}
        }

        try {
            const result = await fetch(`${this.config.base_url()}/${url}${this.#encode_query(query)}`, {
                method,
                headers: headers as any,
                ...payload ? { body: JSON.stringify(payload) } : {},
            }).then(r => r.text())
            try {
                return JSON.parse(result) as Response
            } catch (e) {
                return null
            }
        } catch (error) {
            throw error
        }
    }

    async get<T>(ref: string, query: any = {}) {
        return await this.call<{}, {}, T>(ref, 'GET', query, null)
    }

    async add<T extends {} = {}>(ref: string, data: Partial<T>): Promise<any> {
        return await this.call(ref, 'POST', {}, data)
    }

    async update<T extends {} = {}>(ref: string, data: Partial<T>, method: 'PATCH' | 'PUT' = 'PATCH'): Promise<any> {
        return await this.call(ref, method, {}, data)
    }

    async remove(ref: string): Promise<void> {
        return await this.call(ref, 'DELETE')
    }

    async trigger<Query = any, Payload = any, Response = void>(ref: string, name: string, query: Query, payload: Payload): Promise<Response> {
        return await this.call<Query, Payload, Response>(`${ref}/~${name}`, 'POST', query, payload)
    }
}