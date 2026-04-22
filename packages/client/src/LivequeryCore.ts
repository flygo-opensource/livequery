import { BehaviorSubject, catchError, concatMap, delayWhen, EMPTY, filter, finalize, from, lastValueFrom, map, merge, mergeMap, Observable, of, shareReplay, Subject, Subscriber, tap } from "rxjs"
import type { LivequeryStorge } from "./LivequeryStorge"
import type { LivequeryQueryResult, LivequeryTransporter } from "./LivequeryTransporter"
import type { DataChangeEvent, LivequeryAction, Doc, LivequeryQueryParams, DocState } from "./types"
import { tryCatch } from "./helpers/tryCatch"


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
    source: 'realtime' | 'action'
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
    o: Subject<Partial<LivequeryQueryResult> & {
        from: 'query' | 'realtime' | 'action'
    }>
    collection_ref: string
}

export class LivequeryCore {

    #collections = new Map<CollectionId, CollectionMetadata>()
    #refs = new Map<Ref, Set<CollectionId>>()
    #queries$ = new Subject<LivequeryQueryParams<any> & { collection: CollectionMetadata }>()
    #adding = new Map<string, Subject<void>>()

    constructor(private readonly config: LivequeryCoreConfig) {
        this.#start()
    }

    #start() {
        const cache = new Map<string, Observable<{ result: Partial<LivequeryQueryResult> }>>()
        const changes$ = new Subject<DataChangeEvent>()
        merge(
            changes$.pipe(
                delayWhen(change => {
                    if (change.type == 'modified' || change.type == 'removed' ) return of(1)
                    return this.#adding.get(change.collection_ref) || of(1)
                }),
                tap(change => this.#sync('realtime', change))
            ),

            this.#queries$.pipe(
                mergeMap(async ({ collection, ref, filters, headers, }) => {
                    if (collection.document_id) {
                        const doc = await this.config.storage.get(collection.collection_ref, collection.document_id)
                        if (doc) {
                            collection.o.next({
                                from: 'query',
                                changes: [{
                                    type: 'added',
                                    collection_ref: collection.collection_ref,
                                    id: doc.id,
                                    data: doc
                                }]
                            })
                            return EMPTY
                        }
                    }
                    return from(Object.values(this.config.transporters)).pipe(
                        map(transporter => {
                            const key = `${ref}?${new URLSearchParams(filters as Record<string, string> || {}).toString()}`
                            const cached = cache.get(key)
                            if (cached) return cached
                            const query = transporter.query({
                                ref,
                                filters,
                                headers,
                            }).pipe(
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
                                map((result, index) => {
                                    if (index == 0) {
                                        cache.delete(key)
                                        return { result }
                                    }
                                    result.changes?.forEach(change => changes$.next(change))
                                }),
                                filter(Boolean),
                                shareReplay()
                            )
                            cache.set(key, query)
                            return query
                        }),
                        mergeMap($ => $),
                        map(({ result }, index) => {
                            collection.o.next({
                                ...result,
                                from: index === 0 ? 'query' : 'realtime'
                            })
                        })
                    )
                }),
                mergeMap($ => $)
            )
        ).subscribe()
    }

    watch(ref: string, collection_id: string) {
        const refs = ref.split('/')
        const document_id = refs.length % 2 == 0 ? refs[refs.length - 1] : undefined
        const collection_ref = refs.length % 2 == 0 ? refs.slice(0, -1).join('/') : ref
        const collections = this.#refs.get(collection_ref) || new Set<CollectionId>()
        collections.add(collection_id)
        this.#refs.set(collection_ref, collections)
        const o = new Subject() as CollectionMetadata['o']
        this.#collections.set(collection_id, {
            o,
            document_id,
            collection_id,
            collection_ref
        })
        return o.pipe(
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
        collection && setTimeout(() => this.#queries$.next({ ...req, collection }))
        return await this.config.storage.query<T>(req.ref, req.filters)
    }


    #sync(source: 'realtime' | 'action', change: DataChangeEvent) {

        const collections = this.#refs.get(change.collection_ref) || new Set<CollectionId>()
        for (const collection_id of collections) {
            const sender = this.#collections.get(collection_id)
            if (!sender) continue
            if (!sender.document_id || sender.document_id === change.id) {
                sender.o.next({
                    changes: [change],
                    from: source
                })
                const new_id = change.data?.id
                if (sender.document_id && new_id) {
                    sender.document_id = new_id
                }
            }
        }
        return change.data
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
                            this.#sync('action', {
                                collection_ref,
                                type: 'modified',
                                id,
                                data: fnd
                            })
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
                            this.#sync('action', {
                                collection_ref,
                                type: 'modified',
                                id,
                                data: fnd
                            })
                        } else {
                            await this.config.storage.delete<T>(collection_ref, id)
                            this.#sync('action', {
                                collection_ref,
                                type: 'removed',
                                id
                            })
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
                        this.#sync('action', {
                            collection_ref,
                            type: 'modified',
                            id,
                            data: fnd
                        })
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
        this.#sync('action', {
            id: data.id,
            type: 'added',
            data,
            collection_ref
        })
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
        const doc = await this.#sync('action', {
            collection_ref,
            id,
            type: 'modified',
            data: {
                _prev,
                _updating: true,
                ...data,
            }
        })
        await this.#push(collection_ref, id, { ...data, _prev, _updating: true })
        return doc
    }

    async delete<T extends Doc>(collection_ref: string, id: string) {
        const soft = Object.keys(this.config.transporters).length > 0
        const is_local_doc = id.startsWith('local:')
        if (!soft || is_local_doc) {
            await this.config.storage.delete<T>(collection_ref, id)
            await this.#sync('action', {
                collection_ref,
                id,
                type: 'removed'
            })
            return
        }
        await this.config.storage.update<T>(collection_ref, id, { _deleting: true })
        const doc = await this.#sync('action', {
            collection_ref,
            id,
            type: 'modified',
            data: {
                _deleting: true
            }
        })
        await this.#push(collection_ref, id, { ...doc, _deleting: true })
        return doc
    }

    trigger<Response>(action: LivequeryAction) {
        return from(Object.values(this.config.transporters)).pipe(
            mergeMap(transporter => transporter.trigger<Response>(action))
        )
    }
}