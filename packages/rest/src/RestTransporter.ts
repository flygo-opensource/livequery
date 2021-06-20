import { Transporter, QueryOption, QueryStream, QueryData, CollectionResponse, DocumentResponse } from '@livequery/types'
import { firstValueFrom, Observable, of } from 'rxjs';
import { catchError, concatMap, filter, finalize, map, mapTo, mergeMap, take, tap } from 'rxjs/operators';
import { ajax } from 'rxjs/ajax'
import { from, merge } from 'rxjs'
import { Socket } from './Socket';

const mapper = {
    '==': 'eq',
    '!=': 'ne',
    '<': 'lt',
    '<=': 'lte',
    '>': 'gt',
    '>=': 'gte',
    'in-array': 'in-array',
    'contains': 'contains',
    'not-in-array': 'not-in-array',
    'like': 'like'
}

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

    async get<T>(ref: string) {
        const { response } = await firstValueFrom(ajax<T>(ref))
        return response
    }

    query<T extends { id: string }>(query_id: number, ref: string, options?: Partial<QueryOption<T>>): Observable<QueryStream<T>> {


        const { _cursor, _limit = 20, _order_by, _sort = 'desc', filters = [] } = options
        const query = {
            ...filters.reduce((p, [name, expression, value]) => {
                p[expression == '==' ? name as string : `${name}[${mapper[expression]}]`] = value
                return p
            }, {} as any),
            _limit,
            ..._cursor ? { _cursor } : {},
            ..._order_by ? { _order_by, _sort } : {}
        }

        const get_headers = async () => {
            let headers = await this.config.headers?.() || {}
            this.socket?.socket_session && (headers.socket_id = this.socket?.socket_session)
            return headers
        }

        

        const $when_socket_ready: Observable<any> = this.socket?.$last_state.pipe(
            filter(s => s == 1)
        ) || of(true) 

        const http_request = $when_socket_ready
            .pipe( 
                mergeMap(get_headers),
                concatMap(headers => ajax<QueryData<T>>({
                    url: `${this.config.base_url()}/${ref}`,
                    queryParams: query,
                    headers,
                    responseType: 'json'
                })),
                catchError(e => of({
                    response: { error: { code: e.message, data: { items: [] } } } as QueryData<T>
                })),
                map(({ response }) => {
                    const collection_response = response as CollectionResponse<T>
                    const document_response = response as DocumentResponse<T>

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

        return merge(http_request, websocket_sync)
    }

    private async call<Query = any, Payload = any, Response = void>(url: string, method: string, query: Query = {} as Query, payload?: Payload): Promise<Response> {
        const { response } = await firstValueFrom(from(this.config.headers?.() || Promise.resolve({}))
            .pipe(
                concatMap(headers => ajax<Response>({
                    url: `${this.config.base_url()}/${url}`,
                    queryParams: query as {},
                    headers,
                    method,
                    body: payload
                }))
            ))
        return response
    }

    async add<T extends {} = {}>(ref: string, data: Partial<T>): Promise<any> {
        return await this.call(ref, 'GET', {}, data)
    }

    async update<T extends {} = {}>(ref: string, data: Partial<T>): Promise<any> {
        return await this.call(ref, 'PATCH', {}, data)
    }

    async remove(ref: string): Promise<void> {
        return await this.call(ref, 'DELETE')
    }

    async trigger<Query = any, Payload = any, Response = void>(ref: string, name: string, query: Query, payload: Payload): Promise<Response> {
        return await this.call(`${ref}~${name}`, 'POST', query, payload)
    }
}