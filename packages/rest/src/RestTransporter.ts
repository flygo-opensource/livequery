import { Transporter, QueryOption, QueryStream, QueryData, Paging } from '@livequery/types'
import { Observable, of } from 'rxjs';
import { catchError, filter, finalize, map, mergeMap } from 'rxjs/operators';
import { from, merge, Subject } from 'rxjs'
import { Socket } from './Socket';
import { stringify } from 'query-string'


type MaybePromise<T> = T | Promise<T>

export type RestTransporterConfig = {
    websocket_url: () => MaybePromise<string>,
    base_url: () => MaybePromise<string>,
    headers?: () => Promise<{ [key: string]: string }>
    realtime?: boolean
}

export class RestTransporter implements Transporter {

    private queries = new Set<number>()
    private socket: Socket

    constructor(
        private config: RestTransporterConfig
    ) {
        config.realtime && (this.socket = new Socket(config.websocket_url))
    }

    async get<T>(ref: string, query: any = {}) {
        return await this.call<{}, {}, T>(ref, 'GET', query, null)
    }

    query<T extends { id: string }>(ref: string, options?: Partial<QueryOption<T>>) {

        const $on_reload = new Subject()

        const $when_socket_ready: Observable<any> = this.socket?.$last_state.pipe(
            filter(s => s == 1)
        ) || of(true)

        const $on_can_reload = $on_reload.pipe(filter(() => !this.socket || this.socket.$last_state.getValue() == 1))

        const http_request = merge($when_socket_ready, $on_can_reload)
            .pipe(
                mergeMap(() => this.call<any, null, QueryData<T>>(ref, 'GET', options)),
                map(response => {
                    const collection_response = response as { items: T[]; paging: Paging; }
                    const document_response = response as T

                    // If collection
                    if (collection_response.items) {
                        const { items, paging } = collection_response
                        return {
                            data: {
                                changes: items.map(data => ({ data, type: 'added', ref })),
                                paging: { ...paging, n: 0 }
                            }
                        } as QueryStream<T>
                    }

                    // If document  
                    return {
                        data: {
                            changes: [{ data: document_response, type: 'added', ref }],
                            paging: { n: 0 }
                        }
                    } as QueryStream<T>

                }),
                catchError(error => of({ error })),
            )


        const websocket_sync = (!this.socket || options._cursor) ? from([]) as Observable<QueryStream<T>> : (
            this.socket.listen(ref).pipe(
                map((change) => ({ data: { changes: [change] } } as QueryStream<T>)),
            )
        )

        return Object.assign(
            merge(http_request, websocket_sync),
            {
                reload: () => $on_reload.next(0)
            })
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
            ... this.config.realtime ? { socket_id: this.socket.socket_session } : {}
        }

        try {
            const { data, error, statusCode, message } = await fetch(`${this.config.base_url()}/${url}${this.#encode_query(query)}`, {
                method,
                headers: headers as any,
                ...payload ? { body: JSON.stringify(payload) } : {},
            })
                .then(r => r.json())
            if (error) throw typeof error == 'string' ? { error: { message: error, code: error } } : error
            if (statusCode > 205) throw { message }
            return data
        } catch (e) {
            throw e.error || e
        }
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