import { concatMap, defer, EMPTY, expand, filter, finalize, forkJoin, from, groupBy, lastValueFrom, map, merge, mergeMap, Observable, of, scan, shareReplay, Subject, Subscription, switchMap, take, takeUntil, takeWhile, tap, toArray } from "rxjs"
import type { LivequeryStorage } from "./LivequeryStorage.js"
import type { LivequeryQueryResult, LivequeryTransporter } from "./LivequeryTransporter.js"
import type { DataChangeEvent, LivequeryAction, Doc, DocError, LivequeryQueryParams, DocState, LivequeryFilters, RealtimeChangeSource, ParitalDocState } from "./types.js"
import { LIVEQUERY_OUTBOX_REF, LivequeryOutbox, type OutboxEntry, type OutboxExecution, type OutboxOperation } from "./LivequeryOutbox.js"
import { tryCatch } from "./helpers/tryCatch.js"
import { whenCompleted } from "./helpers/whenCompleted.js"
import { matchesParsedFilters, parseFilters, type ParsedFilter } from "./helpers/filterDocs.js"
import { AddLock } from "./helpers/AddLock.js"
import { isRetryableError } from "./helpers/isRetryableError.js"
import { uuidv7 } from 'uuidv7'

export type LivequeryClientOptions = {
    transporters: Record<string, LivequeryTransporter>
    storage: LivequeryStorage
}

export type LivequeryLoadingState = null | 'next' | 'prev' | 'all'

type CollectionId = string
type Ref = string

export type SyncRequest = DataChangeEvent & {
    ref: string,
    collection_ref: string
    source: RealtimeChangeSource
}



export type ConflictResolverFunction = <T extends Doc>(e: {
    from: Record<string, string | number | boolean>
    old_document: T
    change: DataChangeEvent
}) => {
    approved: boolean
    document: T
}


export type LivequeryClientConfig = {
    storage: LivequeryStorage
    transporters: Record<string, LivequeryTransporter>
    /**
     * Decides what to keep when a remote change reaches a document with local edits not yet
     * confirmed. Without one, the local value of each edited field wins until its write is
     * confirmed, and every other field takes the remote value.
     */
    conflictResolver?: ConflictResolverFunction
}

export type ActionMode = 'server-first' | 'local-first' | 'local-only'

export type CollectionMetadata = {
    collection_id: string
    document_id?: string
    data$: Subject<Partial<LivequeryQueryResult> & {
        from: RealtimeChangeSource
    }>
    collection_ref: string
    mode: 'server-first' | 'local-first' | 'cache-first' | 'local-only'
    filters: Partial<LivequeryFilters<any>>
    parsedFilters: ParsedFilter[]
    /** The last first-page query, re-run when a transporter reconnects. */
    last_query?: LivequeryQueryParams<any> & { collection_id: string }
}

type Query = LivequeryQueryParams<any> & { collection: CollectionMetadata, refetch?: boolean }

const isFirstPageQuery = (filters?: Record<string, any>) => !filters?.[':after'] && !filters?.[':before'] && !filters?.[':around']

// Fields a user edit can change: not the id, not client metadata.
const isEditableField = (key: string) => key !== 'id' && !key.startsWith('_')

// What a transporter receives for an add: the document without its id and client metadata.
const toWritePayload = (doc: Record<string, any>) => Object.fromEntries(Object.entries(doc).filter(([k]) => isEditableField(k)))

const pick = (source: Record<string, any> | null | undefined, keys: string[]) => Object.fromEntries(keys.map(k => [k, source?.[k]]))

const isSameValue = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)

// `_prev` fields whose current value is not the one just sent: edited again while the write was out.
const unsentFields = (local: Record<string, any> | null, sent: Record<string, any>) => Object.keys(local?._prev ?? {})
    .filter(k => !(k in sent) || !isSameValue(local?.[k], sent[k]))

// Remote values, except the fields the user edited and has not had confirmed yet.
const rebase = (local: Record<string, any>, remote: Record<string, any>) => {
    const data = { ...remote }
    for (const key of Object.keys(local._prev ?? {})) {
        if (key in data) data[key] = local[key]
    }
    return data
}

// Exists only on this device so far: a refetch that does not see it must not remove it.
const isUnsynced = (doc: Record<string, any>) => String(doc.id).startsWith('local:') || !!doc._adding || !!doc._local_only

const isNotFound = (e: DocError) => e.status === 404 || e.code === 'NOT_FOUND' || e.code === 'HTTP_404'



export class LivequeryClient {

    /** Local-first writes waiting for, or on their way to, the transporters. */
    readonly outbox: LivequeryOutbox

    #collections = new Map<CollectionId, CollectionMetadata>()
    #refs = new Map<Ref, Set<CollectionId>>()
    #queries$ = new Subject<Query>()
    #localSyncingStop$ = new Subject<void>()
    #addLock = new AddLock()
    #running = new Subscription()
    #subscriptions = new Subscription()

    constructor(private readonly config: LivequeryClientConfig) {
        this.outbox = new LivequeryOutbox({
            storage: config.storage,
            execute: entry => this.#execute(entry),
            onQueued: entries => this.#markQueued(entries),
            lock: config.storage.shared ? `livequery-outbox:${config.storage.shared}` : undefined,
        })
        this.#start()
        this.#watchConnections()
        // Resumes writes a previous session (a reload, a killed service worker) left queued.
        Object.keys(config.transporters).length > 0 && this.outbox.start()
    }

    #cache = new Map<string, Observable<Partial<LivequeryQueryResult>>>()
    #query(e: Query, deduplicate_key?: string) {
        const cached = deduplicate_key && this.#cache.get(deduplicate_key)
        if (cached) return cached
        // A refetch may have replaced this entry; only drop it while it is still ours.
        const clear = () => {
            deduplicate_key && this.#cache.get(deduplicate_key) === $ && this.#cache.delete(deduplicate_key)
        }
        const $: Observable<Partial<LivequeryQueryResult>> = from(Object.entries(this.config.transporters)).pipe(
            mergeMap(([transporter_id, transporter]) => (
                transporter.query(e).pipe(
                    // concatMap: storage writes of one emission finish before the next starts, so
                    // an async storage cannot reorder a `modified` after the `removed` that follows it.
                    concatMap(async result => {
                        if (!result.changes) return result
                        const changes: DataChangeEvent[] = []
                        for (const change of result.changes) {
                            const ingested = await this.#ingestRemoteChange(transporter_id, change)
                            ingested && changes.push(ingested)
                        }
                        return { ...result, changes }
                    }),
                    map((result, index) => ({ result, index })),
                    mergeMap(({ result, index }) => {
                        if (index == 0) return of(result)
                        const changes = result.changes || []

                        if (changes.length === 0) return EMPTY
                        if (!this.#addLock.locked(e.collection.collection_ref)) {
                            return from(this.#broadcast(e.collection.collection_ref, 'realtime', { changes })).pipe(
                                switchMap(() => EMPTY)
                            )
                        }

                        const ok_changes = changes.filter(c => c.type != 'added')
                        const delay_changes = changes.filter(c => c.type == 'added')

                        return from(this.#broadcast(e.collection.collection_ref, 'realtime', { changes: ok_changes })).pipe(
                            switchMap(() => this.#addLock.pending(e.collection.collection_ref).pipe(
                                mergeMap(() => from(this.#broadcast(e.collection.collection_ref, 'realtime', { changes: delay_changes }))),
                                switchMap(() => EMPTY)
                            ))
                        )
                    })
                )
            )),
            finalize(clear),
            shareReplay({ bufferSize: 1, refCount: true })
        )
        deduplicate_key && this.#cache.set(deduplicate_key, $)
        return $
    }

    #start() {

        this.#running = merge(

            // Server queries
            this.#queries$.pipe(
                filter(req => req.collection.mode == 'server-first' || req.collection.mode == 'cache-first'),
                mergeMap(e => {
                    const deduplicate_key = `${e.collection.collection_id}:${JSON.stringify(e.filters, Object.keys(e.filters || {}).sort())}`
                    const before = e.filters?.[':before']
                    const after = e.filters?.[':after']
                    const around = e.filters?.[':around']
                    const loading = ((!before && !after) || (before && after) || around) ? 'all' : (before ? 'prev' : 'next')
                    // A background refetch keeps the list on screen instead of flashing a spinner.
                    !e.refetch && e.collection.data$.next({
                        from: 'query',
                        loading: e.collection.document_id ? 'all' : loading
                    })
                    return this.#query(e, deduplicate_key).pipe(
                        takeUntil(whenCompleted(e.collection.data$)),
                        // A new first-page query of the same collection (new filters, a refetch)
                        // replaces this stream and its realtime subscription. Kept alive, every
                        // re-query would add one more stream and realtime events would multiply.
                        takeUntil(this.#queries$.pipe(
                            filter(next => next.collection === e.collection && isFirstPageQuery(next.filters))
                        )),
                        tap(result => {
                            e.collection.data$.next({
                                ...result,
                                from: 'query',
                                loading: null,
                                ...e.refetch ? { refetch: true } : {}
                            })
                        })
                    )
                })
            ),


            // Local queries
            this.#queries$.pipe(
                filter(req => req.collection.mode == 'local-first'),
                groupBy(
                    e => `${e.collection.collection_ref}/${e.collection.document_id || '::'}`,
                    // stopLocalSyncing() đóng group đang mở; group bị xóa khỏi groupBy nên
                    // lần query kế tiếp của cùng collection_ref tạo group mới → fetch lại từ index 0.
                    { duration: () => this.#localSyncingStop$ }
                ),
                mergeMap($ => $.pipe(
                    mergeMap((e, index) => {
                        index == 0 && e.collection.data$.next({
                            from: 'query',
                            loading: 'all'
                        })
                        return merge(
                            of(e),
                            index > 0 ? EMPTY : defer(() => {
                                return this.#query(e).pipe(
                                    expand(res => {
                                        const next = res.paging?.next
                                        if (!next) return EMPTY
                                        return this.#query({
                                            ...e,
                                            filters: { ':after': next.cursor }
                                        })
                                    }),
                                    mergeMap(result => {
                                        return from(this.#broadcast(e.collection.collection_ref, 'query', result)).pipe(
                                            map(() => result)
                                        )
                                    })

                                )
                            }).pipe(switchMap(() => EMPTY))
                        )
                    }),
                    scan(
                        (p, c) => new Set([...p, c.collection.data$].filter($ => !$.closed)),
                        new Set<Subject<any>>()
                    ),
                    map(set => [...set].map($ => whenCompleted($))),
                    switchMap(list => forkJoin(list)),
                    takeWhile(() => false)
                ))

            )
        ).subscribe()
    }

    // A transporter coming online retries the queued writes right away instead of waiting out the
    // backoff. Coming back after a drop also refetches live queries: realtime events sent while
    // the connection was down are gone for good.
    #watchConnections() {
        for (const transporter of Object.values(this.config.transporters)) {
            if (!transporter.status$) continue
            this.#subscriptions.add(transporter.status$.pipe(
                scan((state, { connected }) => ({
                    connected,
                    seen: state.seen || connected,
                    reconnected: connected && state.seen && !state.connected,
                }), { connected: false, seen: false, reconnected: false }),
                filter(state => state.connected)
            ).subscribe(state => {
                this.outbox.trigger()
                state.reconnected && this.refetch()
            }))
        }
    }

    /**
     * Re-run the last first-page query of every live collection and reconcile the result with
     * what is on screen. Called automatically when a transporter reconnects.
     */
    refetch() {
        this.#cache.clear()
        const local_groups = new Set<string>()
        for (const collection of this.#collections.values()) {
            const last = collection.last_query
            if (!last) continue
            if (collection.mode === 'server-first' || collection.mode === 'cache-first') {
                this.#queries$.next({ ...last, collection, refetch: true })
                continue
            }
            if (collection.mode !== 'local-first') continue
            // Local-first collections of one ref share their sync; fetch it once.
            const key = `${collection.collection_ref}/${collection.document_id ?? '::'}`
            if (local_groups.has(key)) continue
            local_groups.add(key)
            this.#refetchLocal({ ...last, collection }).catch(e => console.error('livequery: refetch failed', e))
        }
    }

    /**
     * Đóng mọi local-first sync đang chạy. Lần query kế tiếp của mỗi collection_ref
     * sẽ được fetch lại từ đầu thay vì bị dedup. Gọi khi logout / đổi account.
     */
    stopLocalSyncing() {
        this.#localSyncingStop$.next()
    }

    watch(ref: string, collection_id: string, mode: CollectionMetadata['mode']) {
        const refs = ref.split('/')
        const document_id = refs.length % 2 == 0 ? refs[refs.length - 1] : undefined
        const collection_ref = refs.length % 2 == 0 ? refs.slice(0, -1).join('/') : ref
        if (collection_ref === LIVEQUERY_OUTBOX_REF) throw new Error(`"${LIVEQUERY_OUTBOX_REF}" is reserved for the outbox`)
        const collections = this.#refs.get(collection_ref) || new Set<CollectionId>()
        collections.add(collection_id)
        this.#refs.set(collection_ref, collections)
        const data$ = new Subject() as CollectionMetadata['data$']
        this.#collections.set(collection_id, {
            data$,
            document_id,
            collection_id,
            collection_ref,
            mode,
            filters: {},
            parsedFilters: []
        })
        return data$.pipe(
            finalize(() => {
                this.#collections.delete(collection_id)
                collections.delete(collection_id)
                if (collections.size === 0) {
                    this.#refs.delete(collection_ref)
                }
                // Complete data$ so whenCompleted(data$) fires and the server-query pipeline's
                // takeUntil tears down the (possibly long-lived/realtime) transporter query —
                // otherwise the old ref's subscription leaks after the collection goes away.
                data$.complete()
            })
        )
    }

    async query<T extends Doc>(req: LivequeryQueryParams<T> & { collection_id: string }) {
        const collection = this.#collections.get(req.collection_id)
        if (!collection) throw new Error(`Collection with id ${req.collection_id} not found`)
        if (isFirstPageQuery(req.filters)) collection.last_query = req

        // If document
        if (collection.document_id) {
            const ids = this.#refs.get(collection.collection_ref)
            const collections = ids ? [...ids].map(id => this.#collections.get(id)).filter(c => c && c.document_id) : []
            const doc = await this.config.storage.get<T>(collection.collection_ref, collection.document_id)
            if (collections.length > 0 && doc) return {
                documents: [doc]
            }
        }

        setTimeout(() => this.#queries$.next({
            ...req,
            filters: collection.mode == 'local-first' ? {} : req.filters,
            collection
        }))


        // If collection
        collection.filters = req.filters || {}
        collection.parsedFilters = parseFilters(collection.filters as Record<string, any>)
        if (collection.mode == 'local-first') {
            return await this.config.storage.query<T>(req.ref, req.filters)
        }

        if (collection.mode == 'cache-first') {
            const before = req.filters?.[':before']
            const after = req.filters?.[':after']
            const is_first_query = !before && !after
            if (is_first_query) {
                return await this.config.storage.query<T>(req.ref, req.filters)
            }
        }

        if (collection.mode == 'local-only') {
            const data = await this.config.storage.query<T>(req.ref, req.filters)
            await this.#broadcast(collection.collection_ref, 'query', {
                changes: data.documents.map(doc => ({
                    collection_ref: collection.collection_ref,
                    id: doc.id,
                    type: 'added',
                    data: doc
                }))
            })
        }
    }


    async #filterLocalEvents(collection: CollectionMetadata, events: Array<DataChangeEvent>, docs: Map<string, Promise<Doc | null>>) {
        const changes: DataChangeEvent[] = []
        for (const event of events) {
            if (event.type == 'removed') {
                changes.push(event)
                continue
            }

            if (event.type == 'added') {
                event.data && matchesParsedFilters(event.data, collection.parsedFilters) && changes.push(event)
                continue
            }

            // A confirmed add moves the document from its `local:` id to the server id: storage
            // already holds it under the new one.
            const stored_id = event.data?.id ?? event.id
            const cache_key = `${event.collection_ref}/${stored_id}`
            const cached = docs.get(cache_key) || this.config.storage.get(collection.collection_ref, stored_id)
            docs.set(cache_key, cached)
            const doc = await cached
            if (doc && matchesParsedFilters(doc as Record<string, any>, collection.parsedFilters)) {
                changes.push(event)
                continue
            }

            changes.push({
                collection_ref: event.collection_ref,
                id: event.id,
                type: 'removed'
            })
        }
        return changes
    }

    async #broadcast(collection_ref: string, from: RealtimeChangeSource, e: Partial<LivequeryQueryResult>) {
        const changes = e.changes || []
        const collections = this.#refs.get(collection_ref) || new Set<CollectionId>()
        const docs = new Map<string, Promise<Doc | null>>()
        for (const collection_id of collections) {
            const collection = this.#collections.get(collection_id)
            if (!collection) continue

            if (collection.document_id) {
                // Is document
                const change = changes.find(c => c.id == collection.document_id)
                change && collection.data$.next({
                    ...e,
                    changes: [change],
                    from,
                    loading: null
                })
                continue
            }

            // If local collection
            if (collection.mode == 'local-first' || collection.mode == 'local-only') {
                const list = await this.#filterLocalEvents(collection, changes, docs)
                // Is collection
                collection.data$.next({
                    ...e,
                    changes: list,
                    from,
                    ...from == 'query' ? { loading: null } : {}
                })
                continue
            }

            collection.data$.next({
                ...e,
                from,
                ...from == 'query' ? { loading: null } : {}
            })



        }
    }


    async add<T extends Doc>(collection_ref: string, documents: Partial<DocState<T>>[], mode: ActionMode, context?: Record<string, any>) {
        if (mode == 'server-first') {
            return await this.#sendNow<T>(documents, async ([tid, transporter], doc) => {
                // Placeholder id: the add lock and the confirm path address the document by it.
                const local_id = `local:${uuidv7()}`
                const payload = toWritePayload(doc)
                using _lock = this.#addLock.acquire(collection_ref)
                const [e, data] = await tryCatch(() => transporter.add<T>(collection_ref, payload as T, context), tid)
                if (e) throw e
                await this.#confirmAdd(collection_ref, local_id, data as Doc, payload)
                return data
            })
        }
        const docs = await Promise.all(documents.map(doc =>
            this.config.storage.add<T>(collection_ref, {
                ...doc,
                _adding: true,
                ...mode === 'local-only' ? { _local_only: true } : {}
            } as DocState<T>) as Promise<DocState<T>>
        ))
        await this.#broadcast(
            collection_ref,
            'action',
            {
                changes: docs.map(data => ({
                    collection_ref,
                    id: data.id,
                    type: 'added',
                    data
                } as DataChangeEvent))
            }
        )
        if (mode === 'local-only') return docs
        return await this.#enqueue<T>(collection_ref, 'add', docs, context)
    }

    async update<T extends Doc>(collection_ref: string, documents: ParitalDocState<T>[], mode: ActionMode, context?: Record<string, any>) {
        if (mode == 'server-first') {
            return await this.#sendNow<T>(documents, async ([tid, transporter], doc) => {
                const fields = toWritePayload(doc)
                const [e, data] = await tryCatch(() => transporter.update<T>(collection_ref, doc.id, fields as Partial<T>, context), tid)
                if (e) throw e
                await this.#confirmUpdate(collection_ref, doc.id, fields)
                return data
            })
        }
        const merged = (await Promise.all(documents.map(async doc => {
            const old = await this.config.storage.get<T>(collection_ref, doc.id) as undefined | DocState<T>
            if (!old) return
            // `_prev` keeps the value from before the FIRST unsent edit of each field: it is both
            // the set of fields to push and the base the conflict rebase works from.
            const _prev = Object.keys(doc).filter(isEditableField).reduce((acc, key) => {
                if (key in (old._prev || {})) return acc
                return { ...acc, [key]: (old as any)[key] }
            }, old._prev || {})
            return await this.config.storage.update<T>(collection_ref, doc.id, { _prev, _updating: true, ...doc }) as DocState<T>
        }))).filter(Boolean) as DocState<T>[]
        await this.#broadcast(
            collection_ref,
            'action',
            {
                changes: merged.map(data => ({
                    collection_ref,
                    id: data.id,
                    type: 'modified',
                    data
                } as DataChangeEvent))
            }
        )
        if (mode === 'local-only') return merged
        return await this.#enqueue<T>(collection_ref, 'update', merged, context)
    }

    async delete<T extends Doc>(collection_ref: string, ids: string[], mode: ActionMode, context?: Record<string, any>) {
        if (mode == 'server-first') {
            return await this.#sendNow<T>(ids.map(id => ({ id })), async ([tid, transporter], { id }) => {
                const [e, data] = await tryCatch(() => transporter.delete<T>(collection_ref, id, context), tid)
                if (e) throw e
                await this.#confirmDelete(collection_ref, id)
                return data
            })
        }
        const soft = Object.keys(this.config.transporters).length > 0
        const merged = (await Promise.all(ids.map(async id => {
            const is_local_doc = id.startsWith('local:')
            if (!soft || is_local_doc || mode == 'local-only') {
                return await this.config.storage.delete<T>(collection_ref, id)
            }
            return await this.config.storage.update<T>(collection_ref, id, { _deleting: true })
        }))).filter(Boolean) as T[]
        const deleting_list = (merged as any[]).filter(doc => doc._deleting)
        const deleted_list = (merged as any[]).filter(doc => !doc._deleting)

        await this.#broadcast(
            collection_ref,
            'action',
            {
                changes: deleting_list.map(({ id }) => ({
                    collection_ref,
                    id,
                    type: 'modified',
                    data: {
                        _deleting: true
                    }
                }))
            }
        )

        await this.#broadcast(
            collection_ref,
            'action',
            {
                changes: deleted_list.map(({ id }) => ({
                    collection_ref,
                    id,
                    type: 'removed',
                }))
            }
        )


        if (mode == 'local-only') return merged
        // For a `local:` document the outbox drops the unsent add, or deletes it on the server
        // once an add already in flight comes back with the real id.
        return await this.#enqueue<T>(collection_ref, 'delete', merged, context)
    }

    trigger<Response>(action: LivequeryAction) {
        return from(Object.entries(this.config.transporters)).pipe(
            filter(([id]) => action.transporter_id ? id === action.transporter_id : true),
            mergeMap(([id, transporter]) => transporter.trigger<Response>(action))
        )
    }

    async seedToStorage<T extends Doc>(collection_ref: string, docs: T[]) {
        await Promise.all(docs.map(doc => this.config.storage.add<T>(collection_ref, doc as any)))
    }

    async flush(collection_ref: string) {
        const pending = await this.outbox.pending()
        pending.length > 0 && console.warn(`livequery: flush() drops ${pending.length} write(s) that never reached the server`)
        await this.#broadcast(collection_ref, 'realtime', { changes: [{ collection_ref, id: '*', type: 'removed' }] })
        await this.config.storage.flush()
        this.outbox.cleared()
    }

    destroy() {
        this.#running.unsubscribe()
        this.#subscriptions.unsubscribe()
        this.outbox.stop()
    }

    // ── Read path ──────────────────────────────────────────────────────────────

    // Every change a transporter reports — query results and realtime alike — is written to
    // storage here, BEFORE anyone sees it. A document with unconfirmed local edits is rebased:
    // the edited fields keep their local value, the rest takes the remote one. The returned change
    // is what collections receive; null drops it.
    async #ingestRemoteChange(transporter_id: string, change: DataChangeEvent): Promise<DataChangeEvent | null> {
        const storage = this.config.storage
        const { collection_ref, id } = change
        if (change.type === 'removed') {
            // The server no longer has it: a pending local edit cannot bring it back.
            await storage.delete(collection_ref, id)
            return change
        }
        if (!change.data) return change

        const local = await storage.get<DocState<Doc>>(collection_ref, id)
        if (!local?._prev && !local?._deleting) {
            if (change.type === 'added') {
                await storage.add(collection_ref, { id: change.data.id, ...change.data })
            } else {
                await storage.update(collection_ref, id, change.data)
            }
            return change
        }

        // The user already chose to delete it; the delete goes out and wins.
        if (local._deleting && change.type === 'modified') return null

        const resolver = this.config.conflictResolver
        const resolved = resolver
            ? resolver({ from: { transporter_id }, old_document: local, change })
            : { approved: true, document: rebase(local, change.data) }
        if (!resolved.approved) return null
        const stored = await storage.update(collection_ref, id, resolved.document)
        return { ...change, data: change.type === 'added' ? stored ?? resolved.document : resolved.document }
    }

    // One-shot re-read of a local-first sync, every page. The long-lived sync keeps running; this
    // only repairs what it missed. Documents the server no longer returns are removed locally.
    async #refetchLocal(e: Query) {
        const count = Object.keys(this.config.transporters).length
        // No filters: a first-page read without opening another realtime subscription.
        const read = (filters?: Record<string, any>) => this.#query({ ...e, filters }).pipe(take(count))
        const pages = await lastValueFrom(read().pipe(
            expand(page => page.paging?.next ? read({ ':after': page.paging.next.cursor }) : EMPTY),
            toArray()
        ))
        // A partial read cannot tell deleted from not-yet-fetched.
        if (pages.some(page => page.error)) return
        const { collection_ref, document_id } = e.collection
        const changes = pages.flatMap(page => page.changes ?? [])
        if (!document_id) {
            const seen = new Set(changes.map(change => change.id))
            const { documents } = await this.config.storage.query<DocState<Doc>>(collection_ref)
            for (const doc of documents) {
                if (seen.has(doc.id) || isUnsynced(doc)) continue
                await this.config.storage.delete(collection_ref, doc.id)
                changes.push({ collection_ref, id: doc.id, type: 'removed' })
            }
        }
        await this.#broadcast(collection_ref, 'query', { changes, refetch: true })
    }

    // ── Write path ─────────────────────────────────────────────────────────────

    // server-first: send to every transporter right away and throw on the first failure.
    async #sendNow<T extends Doc>(
        docs: Array<Record<string, any>>,
        send: (transporter: [string, LivequeryTransporter], doc: Record<string, any> & { id: string }) => Promise<unknown>,
    ): Promise<DocState<T>[]> {
        const results = await Promise.all(docs.flatMap(doc =>
            Object.entries(this.config.transporters).map(entry => send(entry, doc as Record<string, any> & { id: string }))
        ))
        return results.filter(Boolean) as DocState<T>[]
    }

    // local-first: the outbox sends the write. Resolve with the server's answer, or with the local
    // document when the write is stuck behind a network failure.
    async #enqueue<T extends Doc>(collection_ref: string, op: OutboxOperation, docs: Array<{ id: string }>, context?: Record<string, any>) {
        const results = await Promise.all(docs.flatMap(doc =>
            Object.keys(this.config.transporters).map(async transporter_id => {
                const settlement = await this.outbox.enqueue({ transporter_id, collection_ref, op, doc_id: doc.id, context })
                if (settlement.status === 'done') return settlement.data
                if (settlement.status === 'queued') return await this.config.storage.get<T>(collection_ref, doc.id) ?? doc
            })
        ))
        return results.filter(Boolean) as DocState<T>[]
    }

    async #execute(entry: OutboxEntry): Promise<OutboxExecution> {
        const { transporter_id: tid, collection_ref, doc_id: id, context } = entry
        const transporter = this.config.transporters[tid]
        if (!transporter) {
            return { status: 'failed', error: { code: 'TRANSPORTER_NOT_FOUND', message: `No transporter "${tid}"`, transporter_id: tid } }
        }
        const doc = await this.config.storage.get<DocState<Doc>>(collection_ref, id)

        if (entry.op === 'add') {
            // Deleted locally before it was sent.
            if (!doc) return { status: 'done' }
            const payload = toWritePayload(doc)
            using _lock = this.#addLock.acquire(collection_ref)
            const [e, data] = await tryCatch(() => transporter.add(collection_ref, payload as Doc, context), tid)
            if (e) return await this.#failed(entry, e)
            await this.#confirmAdd(collection_ref, id, data as Doc, payload)
            return { status: 'done', data }
        }

        if (entry.op === 'update') {
            const fields = pick(doc, Object.keys(doc?._prev ?? {}))
            // An earlier write already carried these fields.
            if (Object.keys(fields).length === 0) return { status: 'done' }
            const [e, data] = await tryCatch(() => transporter.update(collection_ref, id, fields, context), tid)
            if (e) return await this.#failed(entry, e)
            await this.#confirmUpdate(collection_ref, id, fields)
            return { status: 'done', data }
        }

        const [e, data] = await tryCatch(() => transporter.delete(collection_ref, id, context), tid)
        // Already gone on the server is what a replayed delete wants.
        if (e && !isNotFound(e)) return await this.#failed(entry, e)
        await this.#confirmDelete(collection_ref, id)
        return { status: 'done', data }
    }

    async #failed(entry: OutboxEntry, e: DocError): Promise<OutboxExecution> {
        if (isRetryableError(e)) return { status: 'retry', error: e }
        const flags = {
            add: { _adding: undefined, _adding_error: e },
            update: { _prev: undefined, _updating: undefined, _updating_error: e },
            delete: { _deleting: undefined, _deleting_error: e },
        }[entry.op]
        await this.#patchLocal(entry.collection_ref, entry.doc_id, { ...flags, _queued: undefined })
        return { status: 'failed', error: e }
    }

    async #confirmAdd(collection_ref: string, local_id: string, data: Doc, sent: Record<string, any>) {
        const local = await this.config.storage.get<DocState<Doc>>(collection_ref, local_id)
        // Fields edited again after the add went out are still unsent: keep them and their `_prev`.
        const unsent = unsentFields(local, sent)
        const fnd = {
            ...data,
            ...pick(local, unsent),
            _adding: undefined,
            _adding_error: undefined,
            _queued: undefined,
            _prev: unsent.length > 0 ? pick(local?._prev, unsent) : undefined,
            _updating: unsent.length > 0 ? true : undefined,
        }
        await this.config.storage.update(collection_ref, local_id, fnd)
        data?.id && await this.outbox.remap(collection_ref, local_id, data.id)
        await this.#broadcast(collection_ref, 'action', {
            changes: [{ collection_ref, type: 'modified', id: local_id, data: fnd }]
        })
    }

    async #confirmUpdate(collection_ref: string, id: string, sent: Record<string, any>) {
        const local = await this.config.storage.get<DocState<Doc>>(collection_ref, id)
        const unsent = unsentFields(local, sent)
        await this.#patchLocal(collection_ref, id, {
            _prev: unsent.length > 0 ? pick(local?._prev, unsent) : undefined,
            _updating: unsent.length > 0 ? true : undefined,
            _updating_error: undefined,
            _queued: undefined,
        })
    }

    async #confirmDelete(collection_ref: string, id: string) {
        await this.config.storage.delete(collection_ref, id)
        await this.#broadcast(collection_ref, 'action', {
            changes: [{ collection_ref, type: 'removed', id }]
        })
    }

    async #markQueued(entries: OutboxEntry[]) {
        for (const entry of entries) {
            const doc = await this.config.storage.get<DocState<Doc>>(entry.collection_ref, entry.doc_id)
            if (!doc || doc._queued) continue
            await this.#patchLocal(entry.collection_ref, entry.doc_id, { _queued: true })
        }
    }

    async #patchLocal(collection_ref: string, id: string, fnd: Record<string, any>) {
        await this.config.storage.update(collection_ref, id, fnd)
        await this.#broadcast(collection_ref, 'action', {
            changes: [{ collection_ref, type: 'modified', id, data: fnd }]
        })
    }
}
