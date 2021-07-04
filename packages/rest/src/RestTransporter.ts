import { Transporter, QueryOption, QueryStream, QueryData, CollectionResponse, DocumentResponse } from '@livequery/types'
import { firstValueFrom, Observable, of } from 'rxjs';
import { catchError, concatMap, filter, finalize, map, mergeMap } from 'rxjs/operators';
import { ajax } from 'rxjs/ajax'
import { from, merge, Subject } from 'rxjs'
import { Socket } from './Socket';
import ky from 'ky-universal'


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

    query<T extends { id: string }>(query_id: number, ref: string, options?: Partial<QueryOption<T>>) {

        const $on_reload = new Subject()

        const $when_socket_ready: Observable<any> = this.socket?.$last_state.pipe(
            filter(s => s == 1)
        ) || of(true)

        const $on_can_reload = $on_reload.pipe(filter(() => !this.socket || this.socket.$last_state.getValue() == 1))

        const http_request = merge($when_socket_ready, $on_can_reload)
            .pipe(
                mergeMap(() => this.call<any, null, QueryData<T>>(ref, 'GET', options)),
                catchError(error => of({ error })),
                map(response => {
                    const collection_response = response as CollectionResponse<T>
                    const document_response = response as DocumentResponse<T>

                    // If error
                    if (collection_response.error) {
                        return { error: collection_response.error }
                    }


                    // If collection
                    if (collection_response.data?.items) {
                        const { data: { items, paging }, error } = collection_response
                        return {
                            data: {
                                changes: items.map(data => ({ data, type: 'added', ref })),
                                paging: { ...paging, n: 0 }
                            },
                            error
                        } as QueryStream<T>
                    }

                    // If document 
                    const { data, error } = document_response
                    return {
                        data: {
                            changes: [{ data, type: 'added', ref }],
                            paging: { n: 0 }
                        },
                        error
                    } as QueryStream<T>

                })
            )


        const websocket_sync = (!this.socket || this.queries.has(query_id)) ? from([]) as Observable<QueryStream<T>> : (
            this.queries.add(query_id),
            this.socket.listen(ref).pipe(
                map((change) => ({ data: { changes: [change] } } as QueryStream<T>)),
                finalize(() => this.queries.delete(query_id))
            )
        )

        return Object.assign(
            merge(http_request, websocket_sync),
            {
                reload: () => $on_reload.next(0)
            })
    }

    private async call<Query = any, Payload = any, Response = void>(url: string, method: string, query: Query = {} as Query, payload?: Payload): Promise<Response> {
        return await firstValueFrom(from(this.config.headers?.() || Promise.resolve({}))
            .pipe(
                concatMap(headers => ky(`${this.config.base_url()}/${url}`, {
                    method,
                    searchParams: query as any,
                    headers,
                    throwHttpErrors: false,
                    retry: 3,
                    ...payload ? { json: payload } : {}
                }).json()),
                map((response: Response) => {
                    if ((response as any)?.error) throw (response as any).error
                    return response
                })
            ))
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