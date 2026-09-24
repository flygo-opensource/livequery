import { of, firstValueFrom, EMPTY, from, type Observable } from 'rxjs';
import { catchError, delay, distinctUntilChanged, filter, first, map, mergeMap, take } from 'rxjs/operators';
import { merge } from 'rxjs'
import { Socket } from './Socket.js';
import type { Doc, LivequeryTransporter, LivequeryResult, LivequeryQueryResult, LivequeryAction, LivequeryFilters, LivequeryWriteOptions } from '@livequery/client'
import { parseJson } from './helpers/parseJson.js';


export type RestTransporterRequest = Omit<RequestInit, 'body' | 'headers'> & {
    url: string
    query?: Record<string, any>
    body?: BodyInit | Record<string, any> | null
    headers?: HeadersInit
}

export type Promiseable<T> = T | Promise<T>

export type RestTransporterConfig = {
    api: string
    ws?: string
    credentials?: RequestCredentials
    onRequest?: (options: RestTransporterRequest & { ref: string, context?: Record<string, any> }) => Promiseable<Partial<RestTransporterRequest & { response?: LivequeryResult<any> }>> | void
    onResponse?: (request: RestTransporterRequest & { ref: string }, response: LivequeryResult<any>) => Promise<void> | void
    /**
     * Log every HTTP call once it settles. `true` writes to `console.debug`; a function receives
     * the entry instead. A client in a SharedWorker makes its requests from the worker, so neither
     * the page's devtools network tab nor a Playwright trace shows them — pass a function that
     * forwards the entry to the page (`BroadcastChannel`, the rpc channel) to see them there.
     */
    debug?: boolean | ((entry: RestTransporterDebugEntry) => void)
}

export type RestTransporterDebugEntry = {
    method: string
    url: string
    /** Request headers as sent, so a missing `if-match` or client id is visible. */
    headers: Record<string, string>
    /** HTTP status; absent when the request never got a response (network, CORS, timeout). */
    status?: number
    error?: { code: string, message: string }
    ms: number
}

function normalizeHeaders(headers?: HeadersInit): Record<string, string> {
    const normalized: Record<string, string> = {}
    if (!headers) return normalized

    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        headers.forEach((value, key) => {
            normalized[key] = value
        })
        return normalized
    }

    if (Array.isArray(headers)) {
        for (const [key, value] of headers) {
            normalized[key] = value
        }
        return normalized
    }

    for (const [key, value] of Object.entries(headers)) {
        if (value !== undefined) normalized[key] = String(value)
    }
    return normalized
}

function isBodyInit(body: unknown): body is BodyInit {
    return typeof body === 'string'
        || body instanceof ArrayBuffer
        || ArrayBuffer.isView(body)
        || (typeof Blob !== 'undefined' && body instanceof Blob)
        || (typeof FormData !== 'undefined' && body instanceof FormData)
        || (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams)
        || (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream)
}

function serializeBody(body: RestTransporterRequest['body']): BodyInit | undefined {
    if (body == null) return undefined
    if (isBodyInit(body)) return body
    return JSON.stringify(body)
}

function shouldUseJsonContentType(body: RestTransporterRequest['body']) {
    return body != null && !isBodyInit(body)
}



export type LivequeryCollectionResponse<T extends Doc> = {
    summary?: any,
    items?: T[],
    item?: T
    subscription_token?: string,
    count?: {
        prev: number, next: number, total: number, current: number
    }
    has?: { prev: boolean, next: boolean }
    cursor?: { first: string, last: string }
    /** The route serves deltas and tombstones (local-first sync). */
    sync?: boolean
}


export class RestTransporter implements LivequeryTransporter {

    private socket: Socket | undefined

    /** Socket connection state; only defined when `ws` is configured. */
    readonly status$: Observable<{ connected: boolean }> | undefined

    constructor(
        private config: RestTransporterConfig
    ) {
        if (config.ws) {
            this.socket = new Socket(config.ws!)
        }
        this.status$ = this.socket?.pipe(
            map(s => ({ connected: s.connected })),
            distinctUntilChanged((a, b) => a.connected === b.connected)
        )
    }

    #buildUrl(req: { ref: string, action?: string, query?: Record<string, any> }) {
        const base = this.config.api.replace(/\/+$/, '')
        const ref = req.ref.replace(/^\/+/, '')
        const action = req.action ? `/~${encodeURIComponent(req.action)}` : ''
        const params = new URLSearchParams()

        for (const [key, value] of Object.entries(req.query || {})) {
            if (value === undefined || value === null) continue
            if (Array.isArray(value)) {
                for (const item of value) params.append(key, String(item))
                continue
            }
            params.set(key, String(value))
        }

        const query = params.toString()
        return `${base}/${ref}${action}${query ? `?${query}` : ''}`
    }

    async #call<T>(req: Omit<RestTransporterRequest, 'url'> & { ref: string, action?: string, context?: Record<string, any> }) {
        const url = this.#buildUrl(req)
        const gateway_id = this.socket
            ? await Promise.race([
                firstValueFrom(this.socket.$gateway),
                new Promise<undefined>(r => setTimeout(() => r(undefined), 3000))
            ])
            : undefined
        const socket_headers = {
            ...this.socket ? {
                socket_id: this.socket.client_id,
                'x-lcid': this.socket.client_id,
                ...(gateway_id ? { 'x-lgid': gateway_id } : {})
            } : {}
        }
        const request_headers = {
            ...shouldUseJsonContentType(req.body) ? {
                'Content-Type': 'application/json'
            } : {},
            ...socket_headers,
            ...normalizeHeaders(req.headers)
        }
        const original_request: RestTransporterRequest & { ref: string, context?: Record<string, any> } = {
            url,
            method: req.method,
            body: req.body,
            headers: request_headers,
            query: req.query,
            ref: req.ref,
            context: req.context
        }
        const modifications = await this.config.onRequest?.(original_request) || {}
        const { response: fake_response, headers, body: modified_body, ...modified } = modifications
        if (fake_response) {
            this.config.onResponse && await this.config.onResponse(original_request, fake_response)
            if (fake_response.error) throw fake_response.error
            return fake_response.data as T
        }
        const has_modified_body = Object.prototype.hasOwnProperty.call(modifications, 'body')
        const body = has_modified_body ? modified_body : req.body
        const final_body = serializeBody(body)
        const request = {
            ref: req.ref,
            url,
            method: req.method,
            ...this.config.credentials ? { credentials: this.config.credentials } : {},
            ...modified as any as {},
            ...final_body !== undefined ? { body: final_body } : {},
            headers: {
                ...shouldUseJsonContentType(body) ? { 'Content-Type': 'application/json' } : {},
                ...socket_headers,
                ...normalizeHeaders(req.headers),
                ...normalizeHeaders(headers)
            },
        }
        const started_at = Date.now()
        let status: number | undefined
        const response: LivequeryResult<T> = await (async () => {
            try {
                const controller = new AbortController()
                const timer = setTimeout(() => controller.abort(), 30000)
                const result = await fetch(request.url, {
                    ...request,
                    signal: controller.signal
                }).finally(() => clearTimeout(timer))
                status = result.status
                const body = await result.text()
                const parsed = parseJson(body)
                if (!result.ok) {
                    return {
                        error: {
                            code: parsed?.error?.code || `HTTP_${result.status}`,
                            message: parsed?.error?.message || 'REQUEST_FAILED',
                            status: result.status
                        }
                    }
                }
                if (!parsed) {
                    return {
                        error: {
                            code: 'InvalidJsonResponse',
                            message: 'InvalidJsonResponse'
                        }
                    }
                }
                return parsed
            } catch (e) {
                return {
                    error: {
                        code: e instanceof TypeError ? 'NETWORK_ERROR' : e instanceof Error ? e.name : 'UnknownError',
                        message: e instanceof Error ? e.message : 'UnknownError'
                    }
                }
            }
        })();
        this.#debug({
            method: String(request.method ?? 'GET'),
            url: request.url,
            headers: request.headers,
            ...status !== undefined ? { status } : {},
            ...response.error ? { error: { code: response.error.code, message: response.error.message } } : {},
            ms: Date.now() - started_at,
        })
        this.config.onResponse && await this.config.onResponse(request, response)
        if (response.error) throw response.error
        // Servers normally wrap payloads in the `{ data }` envelope; fall back to the raw
        // body for backends that return the payload bare (e.g. hono useDatasource).
        if (typeof response === 'object' && response !== null && 'data' in response) return response.data
        return response as any as T
    }

    #debug(entry: RestTransporterDebugEntry) {
        const { debug } = this.config
        if (!debug) return
        if (typeof debug === 'function') return debug(entry)
        const outcome = entry.status ?? entry.error?.code
        console.debug(`[livequery/rest] ${entry.method} ${entry.url} → ${outcome} (${entry.ms}ms)`, entry)
    }

    query<T extends Doc>({ ref, filters, headers, context }: { ref: string, filters?: Partial<LivequeryFilters<T>>, headers?: HeadersInit, context?: Record<string, any> }) {
        const ready$ = this.socket
            ? merge(
                this.socket.pipe(filter(s => !!s.connected), map(() => Date.now())),
                of(Date.now()).pipe(delay(3000))
            ).pipe(first())
            : of(1)
        const watch$ = (!this.socket || !filters || filters[':after'] || filters[':before'] || filters[':around']) ? EMPTY : this.socket.listen(ref)
        const refs = ref.split('/')
        const collection_ref = refs.length % 2 == 0 ? refs.slice(0, -1).join('/') : ref

        const is_document = refs.length % 2 == 0

        return merge(


            ready$.pipe(
                take(1),
                mergeMap(() => (
                    from(this.#call<LivequeryCollectionResponse<T>>({
                        ref,
                        method: 'GET',
                        query: filters,
                        headers,
                        context
                    })).pipe(
                        map(collection => {
                            collection.subscription_token && this.socket?.subscribeWith(collection.subscription_token)
                            return this.#toResult(collection, ref)
                        }),
                        catchError(e => of(this.#toErrorResult(e)))

                    )))
            ),

            watch$.pipe(
                map((change) => {
                    const id = change.data?.id
                    if (id) {
                        const e: Partial<LivequeryQueryResult> = {
                            changes: [
                                {
                                    ...change,
                                    collection_ref,
                                    id
                                }
                            ],
                            source: "realtime"
                        }
                        return e
                    }
                }),
                filter(Boolean)
            )
        )
    }

    /** One read, no realtime subscription: local-first sync loads pages and deltas with it. */
    async read<T extends Doc>({ ref, filters, headers, context }: { ref: string, filters?: Partial<LivequeryFilters<T>>, headers?: HeadersInit, context?: Record<string, any> }): Promise<Partial<LivequeryQueryResult>> {
        try {
            const collection = await this.#call<LivequeryCollectionResponse<T>>({ ref, method: 'GET', query: filters, headers, context })
            return this.#toResult(collection, ref)
        } catch (e) {
            return this.#toErrorResult(e)
        }
    }

    #toResult<T extends Doc>(collection: LivequeryCollectionResponse<T>, ref: string): Partial<LivequeryQueryResult> {
        const refs = ref.split('/')
        const collection_ref = refs.length % 2 == 0 ? refs.slice(0, -1).join('/') : ref
        const is_document = refs.length % 2 == 0
        // If collection
        if (collection.items != null) {
            const items = Array.isArray(collection.items) ? collection.items : []
            const length = items.length
            return {
                summary: collection.summary,
                paging: {
                    current: collection?.count?.current ?? length,
                    total: collection?.count?.total ?? length,
                    next: collection?.has?.next ? {
                        count: collection?.count?.next || 0,
                        cursor: collection?.cursor?.last
                    } : undefined,
                    prev: collection?.has?.prev ? {
                        count: collection?.count?.prev || 0,
                        cursor: collection?.cursor?.first
                    } : undefined
                },
                ...collection.sync === true ? { sync: true } : {},
                changes: items.map(data => ({
                    data,
                    type: 'added',
                    id: data.id,
                    collection_ref
                })),
                source: "query"
            } as Partial<LivequeryQueryResult>
        }

        // If document
        if (collection.item != null) {
            return {
                summary: collection.summary,
                ...collection.sync === true ? { sync: true } : {},
                changes: [{
                    data: collection.item,
                    type: 'added',
                    id: collection.item.id,
                    collection_ref
                }],
                source: "query"
            } as Partial<LivequeryQueryResult>
        }

        // Missing items/item field — server returned unexpected format
        return {
            error: {
                code: is_document ? 'DOCUMENT_NOT_FOUND' : 'INVALID_RESPONSE',
                message: is_document
                    ? `Document not found: server response is missing the 'item' field`
                    : `Server response is missing the 'items' field for collection query`
            },
            source: "query"
        } as Partial<LivequeryQueryResult>
    }

    #toErrorResult(e: any): Partial<LivequeryQueryResult> {
        const error = e instanceof TypeError ? { code: 'NETWORK_ERROR', message: e.message } : e instanceof Error ? { code: e.name, message: e.message } : { code: e.code || 'UnknownError', message: e.message || 'An unknown error occurred', ...typeof e.status === 'number' ? { status: e.status } : {} }
        return { error, source: "query" } as Partial<LivequeryQueryResult>
    }

    // Drop client-private fields (leading underscore, e.g. `_id`, `_local`) before sending a write.
    // `id` goes only on an add, and only as a real id: the client picks a uuidv7 so a retried add
    // cannot create a duplicate. A legacy `local:` id is never sent; on update the id is in the URL.
    #stripPrivateFields(data: Record<string, any>, keep_id = false) {
        return Object.fromEntries(Object.entries(data).filter(([k, v]) => {
            if (k.startsWith('_')) return false
            if (k !== 'id') return true
            return keep_id && typeof v === 'string' && !v.startsWith('local:')
        }))
    }

    async add<T extends Doc>(ref: string, data: Partial<Omit<T, 'id'>>, context?: Record<string, any>) {
        type DT = { id: string, _id: string } & T
        const body = this.#stripPrivateFields(data, true)
        const r = await this.#call<DT & { [key: string]: DT }>({ method: 'POST', ref, body, query: {}, context })
        for (const [k, v] of [['', r], ...Object.entries(r)]) {
            const target = v as any as DT
            const id = target.id || target._id
            if (id) return {
                ...target,
                id
            } as any as T
        }
        throw { code: 'InvalidResponse', message: 'The server did not return a valid response containing the created document.' }
    }

    update<T extends Doc>(collection_ref: string, id: string, data: Partial<T>, context?: Record<string, any>, options?: LivequeryWriteOptions) {
        // `If-Match`: only overwrite the version the edit was based on.
        const headers = options?.if_version !== undefined ? { 'if-match': String(options.if_version) } : undefined
        return this.#call<T>({ method: 'PATCH', ref: collection_ref + '/' + id, body: this.#stripPrivateFields(data), query: {}, context, ...headers ? { headers } : {} })
    }

    delete<T extends Doc>(collection_ref: string, id: string, context?: Record<string, any>) {
        return this.#call<T>({ method: 'DELETE', ref: collection_ref + '/' + id, body: undefined, query: {}, context })
    }


    trigger<T>({ ref, action, payload, context }: LivequeryAction) {
        return this.#call<T>({ method: 'POST', ref, action, body: payload, query: {}, context })
    }
}
