import { defer, EMPTY, from, map, mergeMap, Observable, of, Subject, Subscriber, switchMap } from "rxjs"
import type { LivequeryStorge } from "./LivequeryStorge"
import type { LivequeryQueryResult, LivequeryTransporter } from "./LivequeryTransporter"
import type { DataChangeEvent, LivequeryAction, Doc, LivequeryQueryParams, DocState } from "./types"
import { matchesAllFilters } from "./helpers/filterDocs"



export type LivequeryCoreOptions = {
    transporters: Record<string, LivequeryTransporter>
    storage: LivequeryStorge
}

export type LivequeryLoadingState = {
    next: boolean
    prev: boolean
    all: boolean
}

type CollectionId = string
type Ref = string

export type SyncRequest = LivequeryAction & {
    ref: string,
    collection_ref: string
    source: 'query' | 'realtime' | 'action'
}


export type ConflictResolverFunction = <T extends Doc>(e: {
    from: Record<string, string | number | boolean>
    old_document: T
    change: DataChangeEvent<T>
}) => {
    approved: boolean
    document: T
}


export type LivequeryCoreConfig = {
    storage: LivequeryStorge
    transporters: Record<string, LivequeryTransporter>
    resolver: ConflictResolverFunction
}


export class LivequeryCore {

    #collections = new Map<CollectionId, {
        ref: string
        document_id?: string
        o: Subscriber<Partial<LivequeryQueryResult<any>> & {
            from: 'query' | 'realtime' | 'action'
        }>
    }>()

    #refs = new Map<Ref, Set<CollectionId>>()

    #queries$ = new Subject<LivequeryQueryParams<any> & {
        collection_id: string
        query_id: string
    }>()

    constructor(private readonly config: LivequeryCoreConfig) {
        this.#start()
    }

    #start() {
        // Init here
        this.#queries$.pipe(
            mergeMap(({ collection_id, ref, filters, headers, query_id }) => {
                const sender = this.#collections.get(collection_id)
                if (!sender) return EMPTY
                return from(Object.entries(this.config.transporters)).pipe(
                    mergeMap(([id, transporter]) => transporter.query({
                        ref,
                        filters,
                        headers,
                        query_id,
                        collection_id
                    })),
                    map((result, index) => {
                        const changes = (result.changes || []).filter(change => {
                            if (change.type != 'added') return true
                            return matchesAllFilters(change.data as any as Doc, filters || {})
                        })
                        sender.o.next({
                            ...result,
                            changes,
                            from: index === 0 ? 'query' : 'realtime'
                        })
                    })
                )
            })
        ).subscribe()
    }

    watch<T extends Doc>(ref: string, collection_id: string) {
        const refs = ref.split('/')
        const document_id = refs.length % 2 == 0 ? refs[refs.length - 1] : undefined
        return new Observable<Partial<LivequeryQueryResult<T>>>(o => {
            this.#collections.set(collection_id, {
                o,
                ref,
                document_id
            })
            const refCollections = this.#refs.get(ref) || new Set<CollectionId>()
            refCollections.add(collection_id)
            this.#refs.set(ref, refCollections)

            return () => {
                this.#collections.delete(collection_id)
                refCollections.delete(collection_id)
                if (refCollections.size === 0) {
                    this.#refs.delete(ref)
                }
            }
        })
    }

    async query<T extends Doc>(req: LivequeryQueryParams<T>) {
        setTimeout(() => this.#queries$.next(req), 0)
        return await this.config.storage.query<T>(req.ref, req.filters)
    }



    async #broadcast<T extends Doc>({ source, ref, collection_ref, action, payload }: SyncRequest) {
        const collections = this.#refs.get(ref)
        if (!collections) return
        const change = await (async () => {
            if (action == 'add') {
                const data = await this.config.storage.add<T>(
                    collection_ref,
                    payload as T
                )
                return {
                    id: data.id,
                    type: 'added' as DataChangeEvent<any>['type'],
                    data
                }
            }


            const { id, ...rest } = payload || {}
            if (!id) return
            if (action == 'update') {
                const old = await this.config.storage.get<T>(
                    collection_ref,
                    id
                ) as undefined | DocState<T>
                if (!old) return
                const _prev = Object.keys(rest).reduce((acc, key) => {
                    if (key in (old._prev || {})) return acc
                    return {
                        ...acc,
                        [key]: (old as any)[key]
                    }
                }, old._prev || {})
                await this.config.storage.update<T>(
                    collection_ref,
                    id,
                    {
                        ...rest,
                        _prev
                    }
                )
                return {
                    id,
                    type: 'updated' as DataChangeEvent<any>['type'],
                    data: rest
                }
            }
            if (action == 'delete') {
                const soft = !!payload?._soft
                if (soft) {
                    await this.config.storage.update<T>(
                        collection_ref,
                        id,
                        {
                            _deleting: true
                        }
                    )
                    return {
                        id,
                        type: 'removed' as DataChangeEvent<any>['type'],
                        data: { _deleting: true }
                    }
                } else {
                    const data = await this.config.storage.delete<T>(
                        collection_ref,
                        id
                    )
                    return {
                        id,
                        type: 'removed' as DataChangeEvent<any>['type'],
                        data
                    }
                }

            }
        })();
        if (!change) return
        for (const collection_id of collections) {
            const sender = this.#collections.get(collection_id)
            if (!sender) continue
            if (!sender.document_id || sender.document_id === change.id) {
                sender.o.next({
                    changes: [change],
                    from: source
                })
                if (sender.document_id) {
                    sender.document_id = change.id
                }
            }
        }
        return change.data as T
    }

    async #sync<Response>(ref: string, collection_ref: string, doc: Record<string, any>) {
        return EMPTY as Observable<{ data: Response, error?: Error }>
        if (doc.id.startsWith('local:')) {
            // Try to sync to at least one transporter to get a real id
            // Sync to collections

        }

        // Sync to all remote transporters
        for (const transporter of Object.values(this.config.transporters)) {

        }

    }

    trigger<Response>(action: LivequeryAction) {
        const options = this.#collections.get(action.collection_id)
        if (!options) throw new Error(`Collection with id ${action.collection_id} not found (maybe disconnected)`)

        const refs = action.ref.split('/')
        const collection_ref = refs.length % 2 == 0 ? refs.slice(0, -1).join('/') : action.ref
        return from(
            this.#broadcast<Doc>({
                ...action,
                collection_ref,
                source: 'action'
            })
        ).pipe(
            switchMap(change => {
                if (change) {
                    const targets = Object.entries(this.config.transporters)
                    if (targets.length == 0) return of({ data: change, error: undefined })
                    if (['add', 'update', 'delete'].includes(action.action)) {
                        return from(this.#sync<Response>(action.ref, collection_ref, change)).pipe(
                            mergeMap($ => $)
                        )
                    }
                }
                return from(Object.entries(this.config.transporters)).pipe(
                    mergeMap(([id, transporter]) => transporter.trigger<Response>(action))
                )
            })
        )
    }


}