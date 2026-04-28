import { concatMap, defer, EMPTY, expand, filter, finalize, forkJoin, from, groupBy, lastValueFrom, map, merge, mergeMap, Observable, of, scan, shareReplay, Subject, switchMap, takeUntil, takeWhile, tap } from "rxjs"
import type { LivequeryStorge } from "./LivequeryStorge.js"
import type { LivequeryQueryResult, LivequeryTransporter } from "./LivequeryTransporter.js"
import type { DataChangeEvent, LivequeryAction, Doc, LivequeryQueryParams, DocState, LivequeryFilters, RealtimeChangeSource } from "./types.js"
import { tryCatch } from "./helpers/tryCatch.js"
import { whenCompleted } from "./helpers/whenCompleted.js"
import { matchesAllFilters } from "./helpers/filterDocs.js"


export type LivequeryCoreOptions = {
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


export type LivequeryCoreConfig = {
    storage: LivequeryStorge
    transporters: Record<string, LivequeryTransporter>
}

export type CollectionMetadata = {
    collection_id: string
    document_id?: string
    data$: Subject<Partial<LivequeryQueryResult> & {
        from: RealtimeChangeSource
    }>
    collection_ref: string
    mode: 'server-first' | 'local-first' | 'cache-first'
    filters: Partial<LivequeryFilters<any>>
}

type Query = LivequeryQueryParams<any> & { collection: CollectionMetadata }



export class LivequeryCore {

    #collections = new Map<CollectionId, CollectionMetadata>()
    #refs = new Map<Ref, Set<CollectionId>>()
    #queries$ = new Subject<Query>()
    #adding = new Map<string, Subject<void>>()

    constructor(private readonly config: LivequeryCoreConfig) {
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
                    // if (e.type == 'modified') {
                    //     if (!e.data) return false
                    //     // TODO: Delete on data not matched
                    //     if (!matchesAllFilters(e.data, collection.filters)) {
                    //         e.type = 'removed'
                    //     }
                    // }
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

    #push<T extends Doc>(collection_ref: string, id: string, doc: Record<string, any>) {
        const cleanDoc = Object.entries(doc).reduce((p, [k, v]) => {
            if (k.startsWith('_')) return p
            return { ...p, [k]: v }
        }, {} as Record<string, any>)

        return lastValueFrom(
            from(Object.entries(this.config.transporters)).pipe(
                concatMap(async ([_transporterId, transporter]) => {
                    if (String(id).startsWith('local:')) {

                        // lock by collection_ref 
                        const o = new Subject<void>()
                        this.#adding.set(collection_ref, o)
                        const [e, data] = await tryCatch(() => transporter.add<T>(collection_ref, cleanDoc as T))
                        // unlock 
                        if (data && data.id) {
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
                        }
                        o.next()
                        o.complete()
                        this.#adding.delete(collection_ref)
                    }

                    // _deleting flag → soft-delete on remote then hard-delete locally 
                    if (doc._deleting) {
                        const [e] = await tryCatch(() => transporter.delete(collection_ref, id))
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
                    }

                    // _prev present → document was updated locally, push changed fields to remote
                    if (doc._prev && Object.keys(doc._prev).length > 0) {
                        const changedFields = Object.keys(doc._prev).reduce<Partial<T>>((acc, key) => ({
                            ...acc,
                            [key]: doc[key as any as keyof typeof doc]
                        }), {})
                        const [e] = await tryCatch(() => transporter.update<T>(collection_ref, id, changedFields))
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
                    }

                    return EMPTY
                })
            ),
            { defaultValue: undefined }
        )
    }

    async add<T extends Doc>(collection_ref: string, doc: Record<string, any>) {
        const data = await this.config.storage.add<T>(
            collection_ref,
            { ...doc, _adding: true } as DocState<T>
        )
        this.#broadcast(collection_ref, 'action', [{
            collection_ref,
            id: data.id,
            type: 'added',
            data
        }])
        await this.#push(collection_ref, data.id, data)
        return data
    }

    async update<T extends Doc>(collection_ref: string, id: string, data: Record<string, any>) {
        const old = await this.config.storage.get<T>(
            collection_ref,
            id
        ) as undefined | DocState<T>
        if (!old) return
        const _prev = Object.keys(data).reduce((acc, key) => {
            if (key in (old._prev || {})) return acc
            return {
                ...acc,
                [key]: (old as any)[key]
            }
        }, old._prev || {})
        await this.config.storage.update<T>(collection_ref, id, { _prev, _updating: true, ...data, })
        const doc = await this.#broadcast(collection_ref, 'action', [{
            collection_ref,
            id,
            type: 'modified',
            data: {
                _prev,
                _updating: true,
                ...data,
            }
        }])
        await this.#push(collection_ref, id, { ...data, _prev, _updating: true })
        return doc
    }

    async delete<T extends Doc>(collection_ref: string, id: string) {
        const soft = Object.keys(this.config.transporters).length > 0
        const is_local_doc = id.startsWith('local:')
        if (!soft || is_local_doc) {
            await this.config.storage.delete<T>(collection_ref, id)
            await this.#broadcast(collection_ref, 'action', [{
                collection_ref,
                id,
                type: 'removed'
            }])
            return
        }
        await this.config.storage.update<T>(collection_ref, id, { _deleting: true })
        const doc = await this.#broadcast(collection_ref, 'action', [{
            collection_ref,
            id,
            type: 'modified',
            data: {
                _deleting: true
            }
        }])
        await this.#push(collection_ref, id, { _deleting: true })
        return doc
    }

    trigger<Response>(action: LivequeryAction) {
        return from(Object.values(this.config.transporters)).pipe(
            mergeMap(transporter => transporter.trigger<Response>(action))
        )
    }
}