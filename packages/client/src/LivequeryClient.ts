import { concatMap, EMPTY, filter, finalize, from, map, merge, mergeMap, Observable, of, scan, shareReplay, Subject, Subscription, switchMap, takeUntil, tap } from "rxjs"
import type { LivequeryStorage } from "./LivequeryStorage.js"
import type { LivequeryQueryResult, LivequeryTransporter } from "./LivequeryTransporter.js"
import type { DataChangeEvent, LivequeryAction, Doc, DocError, LivequeryQueryParams, DocState, LivequeryFilters, RealtimeChangeSource, ParitalDocState, LivequeryMode, LocalFirstConfig } from "./types.js"
import { LIVEQUERY_SYNC_REF, LivequerySync, type SyncHandle, type SyncIngestOptions } from "./LivequerySync.js"
import { encodeCursor } from "./helpers/paginateDocs.js"
import { sortersOf } from "./helpers/sortDocs.js"
import { LIVEQUERY_OUTBOX_REF, LivequeryOutbox, type OutboxEntry, type OutboxExecution, type OutboxOperation, type OutboxSettlement } from "./LivequeryOutbox.js"
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
    /** Local-first only: what the collection declared it needs on the device. */
    sync?: LocalFirstConfig
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

// What a transporter receives for an add: the editable fields plus the id the client chose, so a
// retry after a lost response reuses it and the server rejects the duplicate. A legacy `local:` id
// (documents created before 3.0 and still queued) is left out: the server assigns one.
const toAddPayload = (doc: Record<string, any>) => ({
    ...toWritePayload(doc),
    ...typeof doc.id === 'string' && !doc.id.startsWith('local:') ? { id: doc.id } : {},
})

const isIdAlreadyExists = (e: DocError) => e.code === 'ID_ALREADY_EXISTS'

/** `'local-first'` and `{ ... }` are local-first; the object also says how much to keep in sync. */
export function normalizeMode(mode: LivequeryMode | undefined): { mode: CollectionMetadata['mode'], sync?: LocalFirstConfig } {
    if (mode === undefined) return { mode: 'server-first' }
    if (typeof mode === 'object') return { mode: 'local-first', sync: mode }
    return mode === 'local-first' ? { mode, sync: {} } : { mode }
}

/** Server-maintained version of a document (ms). Changes older than the stored one are ignored. */
export const VERSION_FIELD = 'updated_at'
/** Set by the server on a soft-deleted document, so a sync read can tell this device to delete it. */
export const TOMBSTONE_FIELD = 'deleted_at'

const isOlder = (incoming: Record<string, any>, stored: Record<string, any> | null) => {
    const a = incoming[VERSION_FIELD]
    const b = stored?.[VERSION_FIELD]
    return typeof a === 'number' && typeof b === 'number' && a < b
}

const isNotFound = (e: DocError) => e.status === 404 || e.code === 'NOT_FOUND' || e.code === 'HTTP_404'



export class LivequeryClient {

    /** Local-first writes waiting for, or on their way to, the transporters. */
    readonly outbox: LivequeryOutbox
    /** Keeps the local copy of local-first collections in sync, as each one declares. */
    readonly sync: LivequerySync

    #collections = new Map<CollectionId, CollectionMetadata>()
    #refs = new Map<Ref, Set<CollectionId>>()
    #queries$ = new Subject<Query>()
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
        this.sync = new LivequerySync({
            storage: config.storage,
            transporters: config.transporters,
            ingest: (transporter_id, collection_ref, changes, options) => this.#ingestAndBroadcast(transporter_id, collection_ref, changes, options),
            refetched: (collection_ref, changes) => this.#broadcast(collection_ref, 'query', { changes, refetch: true }),
        })
        this.#start()
        this.#watchConnections()
        if (Object.keys(config.transporters).length > 0) {
            // Resumes writes a previous session (a reload, a killed service worker) left queued.
            this.outbox.start()
            // Resumes the `keep: 'always'` scopes before any collection asks for them.
            this.sync.start().catch(e => console.warn('livequery sync: start failed', e))
        }
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
        for (const collection of this.#collections.values()) {
            const last = collection.last_query
            if (!last) continue
            if (collection.mode === 'server-first' || collection.mode === 'cache-first') {
                this.#queries$.next({ ...last, collection, refetch: true })
            }
        }
        // Local-first scopes catch up through the sync: a delta, or a re-read without versions.
        this.sync.reconnected()
    }

    /**
     * Forget what the local-first scopes hold, so each reloads from the server on next use.
     * Call on logout / account switch.
     */
    stopLocalSyncing() {
        this.sync.cleared()
    }

    watch(ref: string, collection_id: string, requested: LivequeryMode, context?: Record<string, any>) {
        const { mode, sync } = normalizeMode(requested)
        const refs = ref.split('/')
        const document_id = refs.length % 2 == 0 ? refs[refs.length - 1] : undefined
        const collection_ref = refs.length % 2 == 0 ? refs.slice(0, -1).join('/') : ref
        if (collection_ref === LIVEQUERY_OUTBOX_REF) throw new Error(`"${LIVEQUERY_OUTBOX_REF}" is reserved for the outbox`)
        if (collection_ref === LIVEQUERY_SYNC_REF) throw new Error(`"${LIVEQUERY_SYNC_REF}" is reserved for the sync`)
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
            ...sync ? { sync } : {},
            filters: {},
            parsedFilters: []
        })
        const handle: SyncHandle | undefined = sync && Object.keys(this.config.transporters).length > 0
            ? this.sync.acquire(collection_ref, sync, collection_id, context)
            : undefined
        // The first load shows as loading; completeness tells the UI whether more exists.
        const status = handle?.status$.subscribe(status => data$.next({
            from: 'query',
            completeness: this.sync.completeness(collection_ref),
            // Only a first load shows as loading; deltas and realtime happen quietly.
            ...status.extending ? {} : { loading: !status.loaded && status.fetching ? 'all' as const : null },
            ...status.error ? { error: status.error } : {},
        }))
        return data$.pipe(
            finalize(() => {
                status?.unsubscribe()
                handle?.release()
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

        if (collection.document_id && collection.mode == 'local-first') {
            const doc = await this.config.storage.get<T>(collection.collection_ref, collection.document_id)
            return { documents: doc ? [doc] : [], paging: { total: doc ? 1 : 0, current: doc ? 1 : 0 } }
        }

        // If document
        if (collection.document_id) {
            const ids = this.#refs.get(collection.collection_ref)
            const collections = ids ? [...ids].map(id => this.#collections.get(id)).filter(c => c && c.document_id) : []
            const doc = await this.config.storage.get<T>(collection.collection_ref, collection.document_id)
            if (collections.length > 0 && doc) return {
                documents: [doc]
            }
        }

        // Local-first: the device answers; the sync fetches only past what it holds.
        if (collection.mode == 'local-first') {
            collection.filters = req.filters || {}
            collection.parsedFilters = parseFilters(collection.filters as Record<string, any>)
            return await this.#localPage<T>(collection, req.filters ?? {})
        }

        setTimeout(() => this.#queries$.next({
            ...req,
            filters: req.filters,
            collection
        }))


        // If collection
        collection.filters = req.filters || {}
        collection.parsedFilters = parseFilters(collection.filters as Record<string, any>)

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
                const id = doc.id ?? uuidv7()
                const payload = toAddPayload({ ...doc, id })
                using _lock = this.#addLock.acquire(collection_ref)
                const [e, data] = await tryCatch(() => transporter.add<T>(collection_ref, payload as T, context), tid)
                if (e) throw e
                await this.#confirmAdd(collection_ref, id, data as Doc, toWritePayload(payload))
                return data
            })
        }
        const docs = await Promise.all(documents.map(doc =>
            this.config.storage.add<T>(collection_ref, {
                ...doc,
                // The final id, chosen here: the server keeps it, so nothing is renamed later and
                // other documents can point at this one while offline.
                id: doc.id ?? uuidv7(),
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
            // Never reached the server (its add is still queued or in flight): no soft delete.
            const current = await this.config.storage.get<DocState<T>>(collection_ref, id)
            const is_local_doc = id.startsWith('local:') || !!current?._adding
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
        // For a document never created on the server the outbox drops the unsent add, or deletes it
        // on the server once an add already in flight comes back.
        return await this.#enqueue<T>(collection_ref, 'delete', merged, context)
    }

    /**
     * Send again a local-first add or delete the server refused (`_adding_error` /
     * `_deleting_error`) — after the user fixed the cause, or for a "retry" button. The add keeps
     * its id, so a retry can never duplicate. A refused update cannot be retried: its `_prev` was
     * dropped with the failure; edit the document again instead.
     */
    async retry<T extends Doc>(collection_ref: string, ids: string[], context?: Record<string, any>) {
        const adds: DocState<T>[] = []
        const deletes: DocState<T>[] = []
        for (const id of ids) {
            const doc = await this.config.storage.get<DocState<T>>(collection_ref, id)
            if (doc?._adding_error) {
                await this.#patchLocal(collection_ref, id, { _adding_error: undefined, _adding: true })
                adds.push({ ...doc, _adding: true })
            } else if (doc?._deleting_error) {
                await this.#patchLocal(collection_ref, id, { _deleting_error: undefined, _deleting: true })
                deletes.push({ ...doc, _deleting: true })
            }
        }
        const results = await Promise.all([
            adds.length > 0 ? this.#enqueue<T>(collection_ref, 'add', adds, context) : [],
            deletes.length > 0 ? this.#enqueue<T>(collection_ref, 'delete', deletes, context) : [],
        ])
        return results.flat()
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
        this.sync.cleared()
    }

    destroy() {
        this.#running.unsubscribe()
        this.#subscriptions.unsubscribe()
        this.outbox.stop()
        this.sync.stop()
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
        // Two sources (realtime, a sync read) can deliver the same document out of order: never let
        // an older version overwrite a newer one.
        if (isOlder(change.data, local)) return null
        // A tombstone: the document was deleted on the server while this device was not looking.
        if (change.data[TOMBSTONE_FIELD] != null) {
            if (!local) return null
            await storage.delete(collection_ref, id)
            return { collection_ref, id, type: 'removed' }
        }
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

    // A page of a local-first collection, from storage. Past the end of what the device holds,
    // the sync loads the next older page from the server first (when it can).
    async #localPage<T extends Doc>(collection: CollectionMetadata, filters: Record<string, any>) {
        const storage = this.config.storage
        let page = await storage.query<T>(collection.collection_ref, filters)
        const incomplete = () => this.sync.completeness(collection.collection_ref) !== 'complete'
        const limit = Number(filters[':limit']) || undefined
        // Past what the device holds (a short page): ask the server for the next older page.
        const short = limit !== undefined && page.documents.length < limit
        if (!page.paging.next && filters[':after'] && short && incomplete()) {
            collection.data$.next({ from: 'query', loading: 'next' })
            await this.sync.extend(collection.collection_ref, limit).catch(e => {
                collection.data$.next({ from: 'query', error: { code: e?.code ?? 'SYNC_FAILED', message: e?.message ?? 'Cannot load more right now' } })
            })
            page = await storage.query<T>(collection.collection_ref, filters)
            collection.data$.next({ from: 'query', loading: null, completeness: this.sync.completeness(collection.collection_ref) })
        }
        // More may exist on the server: keep a cursor so the UI can ask again (e.g. once online).
        const last = page.documents.at(-1)
        const cursor = last ? encodeCursor(last, sortersOf(filters)) : filters[':after']
        if (!page.paging.next && filters[':limit'] && cursor && incomplete()) {
            page = { ...page, paging: { ...page.paging, next: { count: 0, cursor } } }
        }
        return page
    }

    // The single write path for server data the sync brings: ingest (rebase, versions, storage),
    // then tell the collections. Realtime `added` waits for adds in flight, like the query stream.
    async #ingestAndBroadcast(transporter_id: string, collection_ref: string, changes: DataChangeEvent[], options: SyncIngestOptions) {
        const ingested: DataChangeEvent[] = []
        for (const change of changes) {
            const result = await this.#ingestRemoteChange(transporter_id, { ...change, collection_ref })
            result && ingested.push(result)
        }
        if (options.broadcast === false || ingested.length === 0) return ingested
        const source: RealtimeChangeSource = options.source === 'realtime' ? 'realtime' : 'query'
        if (source === 'realtime' && this.#addLock.locked(collection_ref)) {
            await this.#broadcast(collection_ref, source, { changes: ingested.filter(c => c.type !== 'added') })
            const delayed = ingested.filter(c => c.type === 'added')
            this.#addLock.pending(collection_ref).subscribe(() => {
                this.#broadcast(collection_ref, source, { changes: delayed }).catch(e => console.error('livequery: broadcast failed', e))
            })
            return ingested
        }
        await this.#broadcast(collection_ref, source, { changes: ingested })
        return ingested
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
    async #enqueue<T extends Doc>(collection_ref: string, op: OutboxOperation, docs: Array<{ id: string, _adding?: boolean }>, context?: Record<string, any>) {
        const results = await Promise.all(docs.flatMap(doc =>
            Object.keys(this.config.transporters).map(async transporter_id => {
                const entry = { transporter_id, collection_ref, op, doc_id: doc.id, context }
                const unsynced = op !== 'add' && (doc.id.startsWith('local:') || !!doc._adding)
                const settlement = await this.outbox.enqueue({ ...entry, unsynced }).catch(async (e): Promise<OutboxSettlement> => {
                    // The queue itself could not be written (storage quota, a closed database):
                    // the write is not durable, so say so on the document instead of dropping it.
                    const error: DocError = {
                        code: 'OUTBOX_WRITE_FAILED',
                        message: (e as any)?.message ?? String(e),
                        transporter_id,
                    }
                    await this.#failed({ ...entry, id: '', attempts: 0 }, error)
                    return { status: 'failed', error }
                })
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
            const payload = toAddPayload(doc)
            const sent = toWritePayload(payload)
            using _lock = this.#addLock.acquire(collection_ref)
            const [e, data] = await tryCatch(() => transporter.add(collection_ref, payload as Doc, context), tid)
            // A retry, and the id is taken: the earlier attempt got through but its answer was lost.
            // The document exists; bring it up to date with what was edited since.
            if (e && isIdAlreadyExists(e) && entry.attempts > 0) {
                const [update_error, updated] = await tryCatch(() => transporter.update(collection_ref, id, sent, context), tid)
                if (update_error) return await this.#failed(entry, update_error)
                await this.#confirmAdd(collection_ref, id, { ...updated, id } as Doc, sent)
                return { status: 'done', data: updated }
            }
            if (e) return await this.#failed(entry, e)
            await this.#confirmAdd(collection_ref, id, data as Doc, sent)
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
