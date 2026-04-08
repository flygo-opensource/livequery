import { concatMap, EMPTY, from, lastValueFrom, map, mergeMap, Observable, Subject, Subscriber } from "rxjs"
import type { LivequeryStorge } from "./LivequeryStorge"
import type { LivequeryQueryResult, LivequeryTransporter } from "./LivequeryTransporter"
import type { DataChangeEvent, LivequeryAction, Doc, LivequeryQueryParams, DocState } from "./types"


export type LivequeryCoreOptions<T> = {
    transporters: Record<string, LivequeryTransporter<T>>
    storage: LivequeryStorge
}

export type LivequeryLoadingState = {
    next: boolean
    prev: boolean
    all: boolean
}

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


export type LivequeryCoreConfig<T> = {
    storage: LivequeryStorge
    transporters: Record<string, LivequeryTransporter<T>>
}


export class LivequeryCore<Context> {

    #collections = new Map<CollectionId, {
        ref: string
        document_id?: string
        o: Subscriber<Partial<LivequeryQueryResult> & {
            from: 'query' | 'realtime' | 'action'
        }>
        context: Record<string, any>
    }>()
    #refs = new Map<Ref, Set<CollectionId>>()
    #queries$ = new Subject<LivequeryQueryParams<any> & { collection_id: string }>()

    constructor(private readonly config: LivequeryCoreConfig<Context>) {
        this.#start()
    }

    #start() {
        // Init here
        this.#queries$.pipe(
            mergeMap(({ collection_id, ref, filters, headers }) => {
                const sender = this.#collections.get(collection_id)
                if (!sender) return EMPTY
                return from(Object.values(this.config.transporters)).pipe(
                    mergeMap(transporter => transporter.query({
                        ref,
                        filters,
                        headers,
                    })),
                    map((result, index) => {
                        sender.o.next({
                            ...result,
                            from: index === 0 ? 'query' : 'realtime'
                        })
                        if (index > 0) {
                            for (const change of result.changes || []) {
                                this.#sync('realtime', change)
                            }
                        }
                    })
                )
            })
        ).subscribe()
    }

    watch(ref: string, collection_id: string, context: Record<string, any> = {}) {
        const refs = ref.split('/')
        const document_id = refs.length % 2 == 0 ? refs[refs.length - 1] : undefined
        const collection_ref = refs.length % 2 == 0 ? refs.slice(0, -1).join('/') : ref
        return new Observable<Partial<LivequeryQueryResult>>(o => {
            this.#collections.set(collection_id, {
                o,
                ref,
                document_id,
                context
            })
            const refCollections = this.#refs.get(collection_ref) || new Set<CollectionId>()
            refCollections.add(collection_id)
            this.#refs.set(collection_ref, refCollections)

            return () => {
                this.#collections.delete(collection_id)
                refCollections.delete(collection_id)
                if (refCollections.size === 0) {
                    this.#refs.delete(collection_ref)
                }
            }
        })
    }

    async query<T extends Doc>(req: LivequeryQueryParams<T> & { collection_id: string }) {
        const collections = this.#refs.get(req.ref)
        collections && collections.size == 1 && setTimeout(() => this.#queries$.next(req), 0)
        return await this.config.storage.query<T>(req.ref, req.filters)
    }

    #sync<T extends Doc>(source: 'realtime' | 'action', change: DataChangeEvent) {
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
        return change.data as T
    }

    #push<T extends Doc>(collection_ref: string, doc: Record<string, any>) {
        const cleanDoc = Object.entries(doc).reduce((p, [k, v]) => {
            if (k.startsWith('_')) return p
            return { ...p, [k]: v }
        }, {} as Record<string, any>)

        return lastValueFrom(
            from(Object.entries(this.config.transporters)).pipe(
                concatMap(async ([_transporterId, transporter]) => {
                    // id starts with 'local:' → new document, add to remote
                    if (String(doc.id).startsWith('local:')) {
                        const new_doc = await transporter.add<T>(collection_ref, cleanDoc as T)
                        if (new_doc.id) {
                            await this.config.storage.update<T>(collection_ref, doc.id, { id: new_doc.id })
                            this.#sync('realtime', {
                                collection_ref,
                                type: 'updated',
                                id: doc.id,
                                data: {
                                    id: new_doc.id
                                }
                            })
                        }
                    }

                    // _deleting flag → soft-delete on remote then hard-delete locally

                    const ref = `${collection_ref}/${doc.id}`
                    if (doc._deleting) {
                        const deleted_doc = await transporter.delete(ref, doc.id)
                        await this.config.storage.delete<T>(ref, doc.id)
                        this.#sync('realtime', {
                            collection_ref,
                            type: 'removed',
                            id: doc.id
                        })
                    }

                    // _prev present → document was updated locally, push changed fields to remote
                    if (doc._prev && Object.keys(doc._prev).length > 0) {
                        const changedFields = Object.keys(doc._prev).reduce<Partial<T>>((acc, key) => ({
                            ...acc,
                            [key]: doc[key]
                        }), { id: doc.id } as Partial<T>)
                        await transporter.update<T>(ref, doc.id, changedFields)
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
            doc as T
        )
        await this.#sync('action', {
            id: data.id,
            type: 'added',
            data,
            collection_ref
        })
        await this.#push(collection_ref, data)
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
        const doc = await this.config.storage.update<T>(
            collection_ref,
            id,
            {
                ...data,
                _prev
            }
        )
        this.#sync('action', {
            collection_ref,
            id,
            type: 'updated',
            data: {
                ...data,
                _prev
            }
        })
        doc && await this.#push(collection_ref, doc)
        return doc
    }

    async delete<T extends Doc>(collection_ref: string, id: string) {
        const soft = Object.keys(this.config.transporters).length > 0
        const is_local_doc = id.startsWith('local:')
        if (!soft || is_local_doc) {
            await this.config.storage.delete<T>(
                collection_ref,
                id
            )
            this.#sync('action', {
                collection_ref,
                id,
                type: 'removed'
            })
            return
        }
        const doc = await this.update<T>(collection_ref, id, {
            _deleting: true
        })
        doc && await this.#push(collection_ref, doc)
        return doc
    }

    trigger<Response>(action: LivequeryAction) {
        return from(Object.values(this.config.transporters)).pipe(
            mergeMap(transporter => transporter.trigger<Response>(action))
        )
    }
}