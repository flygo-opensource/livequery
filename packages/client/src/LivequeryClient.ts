import { defer, EMPTY, expand, filter, finalize, forkJoin, from, groupBy, lastValueFrom, map, merge, mergeMap, Observable, of, scan, shareReplay, Subject, switchMap, takeUntil, takeWhile, tap, toArray } from "rxjs"
import type { LivequeryStorge } from "./LivequeryStorge.js"
import type { LivequeryQueryResult, LivequeryTransporter } from "./LivequeryTransporter.js"
import type { DataChangeEvent, LivequeryAction, Doc, LivequeryQueryParams, DocState, LivequeryFilters, RealtimeChangeSource, ParitalDocState } from "./types.js"
import { tryCatch } from "./helpers/tryCatch.js"
import { whenCompleted } from "./helpers/whenCompleted.js"
import { matchesAllFilters } from "./helpers/filterDocs.js"


export type LivequeryClientOptions = {
    transporters: Record<string, LivequeryTransporter>
    storage: LivequeryStorge
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
    storage: LivequeryStorge
    transporters: Record<string, LivequeryTransporter>
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
}

type Query = LivequeryQueryParams<any> & { collection: CollectionMetadata }



export class LivequeryClient {

    #collections = new Map<CollectionId, CollectionMetadata>()
    #refs = new Map<Ref, Set<CollectionId>>()
    #queries$ = new Subject<Query>()
    #adding = new Map<string, Subject<void>>()

    constructor(private readonly config: LivequeryClientConfig) {
        this.#start()
    }

    #cache = new Map<string, Observable<Partial<LivequeryQueryResult>>>()
    #query(e: Query, deduplicate_key?: string) {
        const clear = () => deduplicate_key && this.#cache.delete(deduplicate_key)
        const cached = deduplicate_key && this.#cache.get(deduplicate_key)
        if (cached) return Object.assign(cached, { clear })
        const $ = from(Object.values(this.config.transporters)).pipe(
            mergeMap(transporter => (
                transporter.query(e).pipe(
                    tap(result => {
                        for (const change of result.changes || []) {
                            change.type == 'added' && change.data && this.config.storage.add(change.collection_ref, {
                                id: change.data.id,
                                ...change.data
                            })
                            change.type == 'modified' && change.data && this.config.storage.update(change.collection_ref, change.id, change.data)
                            change.type == 'removed' && this.config.storage.delete(change.collection_ref, change.id)
                        }
                    }),
                    map((result, index) => ({ result, index })),
                    mergeMap(({ result, index }) => {
                        if (index == 0) return of(result)
                        const changes = result.changes || []

                        if (changes.length === 0) return EMPTY
                        const lock$ = this.#adding.get(e.collection.collection_ref)

                        if (!lock$) {
                            this.#broadcast(e.collection.collection_ref, 'realtime', changes)
                            return EMPTY
                        }

                        const ok_changes = changes.filter(c => c.type != 'added')
                        const delay_changes = changes.filter(c => c.type == 'added')

                        this.#broadcast(e.collection.collection_ref, 'realtime', ok_changes)
                        return lock$.pipe(
                            tap(() => this.#broadcast(e.collection.collection_ref, 'realtime', delay_changes)),
                            switchMap(() => EMPTY)
                        )
                    })
                )
            )),
            finalize(clear),
            shareReplay()
        )
        deduplicate_key && this.#cache.set(deduplicate_key, $)
        return Object.assign($, { clear })
    }

    #start() {
        lastValueFrom(merge(

            // Server queries
            this.#queries$.pipe(
                filter(req => req.collection.mode == 'server-first' || req.collection.mode == 'cache-first'),
                mergeMap(e => {
                    const deduplicate_key = `${e.collection.collection_id}:${JSON.stringify(e.filters)}`
                    const before = e.filters?.[':before']
                    const after = e.filters?.[':after']
                    const around = e.filters?.[':around']
                    const loading = ((!before && !after) || (before && after) || around) ? 'all' : (before ? 'prev' : 'next')
                    e.collection.data$.next({
                        from: 'query',
                        loading: e.collection.document_id ? 'all' : loading
                    })
                    return this.#query(e, deduplicate_key).pipe(
                        takeUntil(whenCompleted(e.collection.data$)),
                        tap(result => {
                            e.collection.data$.next({
                                ...result,
                                from: 'query',
                                loading: null
                            })
                        })
                    )
                })
            ),


            // Local queries
            this.#queries$.pipe(
                filter(req => req.collection.mode == 'local-first'),
                groupBy(e => `${e.collection.collection_ref}/${e.collection.document_id || '::'}`),
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
                                    tap(result => {

                                        this.#broadcast(e.collection.collection_ref, 'query', result.changes || [])
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
        ))
    }

    watch(ref: string, collection_id: string, mode: CollectionMetadata['mode']) {
        const refs = ref.split('/')
        const document_id = refs.length % 2 == 0 ? refs[refs.length - 1] : undefined
        const collection_ref = refs.length % 2 == 0 ? refs.slice(0, -1).join('/') : ref
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
            filters: {}
        })
        return data$.pipe(
            finalize(() => {
                this.#collections.delete(collection_id)
                collections.delete(collection_id)
                if (collections.size === 0) {
                    this.#refs.delete(collection_ref)
                }
            })
        )
    }

    async query<T extends Doc>(req: LivequeryQueryParams<T> & { collection_id: string }) {
        const collection = this.#collections.get(req.collection_id)
        if (!collection) throw new Error(`Collection with id ${req.collection_id} not found`)

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
    }


    #broadcast(collection_ref: string, from: RealtimeChangeSource, events: Array<DataChangeEvent>) {
        const collections = this.#refs.get(collection_ref) || new Set<CollectionId>()
        for (const collection_id of collections) {
            const collection = this.#collections.get(collection_id)
            if (!collection) continue

            if (collection.document_id) {
                // Is document
                const change = events.find(c => c.id == collection.document_id)
                change && collection.data$.next({
                    changes: [change],
                    from,
                    loading: null
                })
                continue
            }

            // If local first collection 
            if (collection.mode == 'local-first') {
                const changes = events.filter(e => {
                    if (e.type == 'added') return e.data && matchesAllFilters(e.data, collection.filters)
                    return true
                })
                // Is collection
                collection.data$.next({
                    changes,
                    from,
                    ...from == 'query' ? { loading: null } : {}
                })
                continue
            }

            collection.data$.next({
                changes: events,
                from,
                ...from == 'query' ? { loading: null } : {}
            })



        }
    }

    #push<T extends Doc>(collection_ref: string, docs: Array<Record<string, any> & { id: string }>, server_first: boolean) {
        return lastValueFrom(from(docs).pipe(
            mergeMap(doc => from(Object.entries(this.config.transporters)).pipe(
                mergeMap(async ([tid, transporter]) => {
                    const id = doc.id
                    if (String(id).startsWith('local:')) {
                        // lock by collection_ref 
                        const o = new Subject<void>()
                        this.#adding.set(collection_ref, o)
                        const [e, data] = await tryCatch(() => transporter.add<T>(collection_ref, doc as T))
                        if (e && server_first) throw e
                        // unlock 
                        const fnd = {
                            ...data,
                            _adding: undefined,
                            ...e ? { _adding_error: e } : {}
                        }
                        await this.config.storage.update<T>(collection_ref, id, fnd)
                        this.#broadcast(collection_ref, 'action', [{
                            collection_ref,
                            type: 'modified',
                            id,
                            data: fnd
                        }])
                        o.next()
                        o.complete()
                        this.#adding.delete(collection_ref)
                        return data as DocState<T>
                    }

                    // _deleting flag → soft-delete on remote then hard-delete locally 
                    if (doc._deleting) {
                        const [e, data] = await tryCatch(() => transporter.delete(collection_ref, id))
                        if (e && server_first) throw e
                        if (e) {
                            const fnd = {
                                _deleting: undefined,
                                _deleting_error: e
                            }
                            await this.config.storage.update<T>(collection_ref, id, fnd)
                            this.#broadcast(collection_ref, 'action', [{
                                collection_ref,
                                type: 'modified',
                                id,
                                data: fnd
                            }])
                        } else {
                            await this.config.storage.delete<T>(collection_ref, id)
                            this.#broadcast(collection_ref, 'action', [{
                                collection_ref,
                                type: 'removed',
                                id
                            }])
                        }
                        return data as DocState<T>
                    }

                    // _prev present → document was updated locally, push changed fields to remote
                    if (doc._prev && Object.keys(doc._prev).length > 0) {
                        const changedFields = Object.keys(doc._prev).reduce<Partial<T>>((acc, key) => ({
                            ...acc,
                            [key]: doc[key as any as keyof typeof doc]
                        }), {})
                        const [e, data] = await tryCatch(() => transporter.update<T>(collection_ref, id, changedFields))
                        if (e && server_first) throw e
                        const fnd = {
                            _prev: undefined,
                            _updating: undefined,
                            _updating_error: e
                        }
                        await this.config.storage.update<T>(collection_ref, id, fnd)
                        this.#broadcast(collection_ref, 'action', [{
                            collection_ref,
                            type: 'modified',
                            id,
                            data: fnd
                        }])
                        return data as DocState<T>
                    }
                })
            )),
            filter(Boolean),
            toArray(),
        ), { defaultValue: [] as DocState<T>[] })
    }


    async add<T extends Doc>(collection_ref: string, documents: Partial<DocState<T>>[], mode: ActionMode) {
        if (mode == 'server-first') {
            const list = documents.map(doc => ({ ...doc, id: `local:${Math.random().toString(36).slice(2)}` }))
            return await this.#push<T>(collection_ref, list as Array<Record<string, any> & { id: string }>, true)
        }
        const docs = await lastValueFrom(from(documents).pipe(
            mergeMap(doc => {
                return this.config.storage.add<T>(collection_ref, {
                    ...doc,
                    _adding: true,
                    ...mode === 'local-only' ? { _local_only: true } : {}
                } as DocState<T>) as Promise<DocState<T>>
            }),
            toArray()
        ))
        this.#broadcast(
            collection_ref,
            'action',
            docs.map(data => ({
                collection_ref,
                id: data.id,
                type: 'added',
                data
            } as DataChangeEvent))
        )
        if (mode === 'local-only') return docs
        return await this.#push<T>(collection_ref, docs, false)
    }

    async update<T extends Doc>(collection_ref: string, documents: ParitalDocState<T>[], mode: ActionMode) {
        if (mode == 'server-first') {
            const list = documents.map(doc => ({ ...doc, _prev: doc }))
            return await this.#push<T>(collection_ref, list, true)
        }
        const merged = await lastValueFrom(from(documents).pipe(
            mergeMap(async doc => {
                const old = await this.config.storage.get<T>(
                    collection_ref,
                    doc.id
                ) as undefined | DocState<T>
                if (!old) return
                const _prev = Object.keys(doc).reduce((acc, key) => {
                    if (key in (old._prev || {})) return acc
                    return {
                        ...acc,
                        [key]: (old as any)[key]
                    }
                }, old._prev || {})
                const data = await this.config.storage.update<T>(collection_ref, doc.id, { _prev, _updating: true, ...doc, })
                return data as DocState<T>
            }),
            filter(Boolean),
            toArray()
        ))
        await this.#broadcast(
            collection_ref,
            'action',
            merged.map(data => ({
                collection_ref,
                id: data.id,
                type: 'modified',
                data
            } as DataChangeEvent))
        )
        return await this.#push<T>(collection_ref, merged, false)
    }

    async delete<T extends Doc>(collection_ref: string, ids: string[], mode: ActionMode) {
        if (mode == 'server-first') {
            const list = ids.map(id => ({ id, _deleting: true }))
            return await this.#push<T>(collection_ref, list, true)
        }
        const soft = Object.keys(this.config.transporters).length > 0
        const merged = await lastValueFrom(from(ids).pipe(
            mergeMap(async id => {
                const is_local_doc = id.startsWith('local:')
                if (!soft || is_local_doc) {
                    const doc = await this.config.storage.delete<T>(collection_ref, id)
                    return doc
                }
                return await this.config.storage.update<T>(collection_ref, id, { _deleting: true })
            }),
            filter(Boolean),
            toArray()
        ))
        await this.#broadcast(
            collection_ref,
            'action',
            merged.map(({ id }) => ({
                collection_ref,
                id,
                type: 'removed',
            }))
        )
        return await this.#push<T>(collection_ref, merged, false)
    }

    trigger<Response>(action: LivequeryAction) {
        return from(Object.entries(this.config.transporters)).pipe(
            filter(([id]) => action.transporter_id ? id === action.transporter_id : true),
            mergeMap(([id, transporter]) => transporter.trigger<Response>(action))
        )
    }

    flush(collection_ref: string) {
        this.#broadcast(collection_ref, 'realtime', [{ collection_ref, id: '*', type: 'removed' }])
        return this.config.storage.flush()
    }
}