import { defer, EMPTY, from, map, mergeMap, Observable, of, Subject, Subscriber, switchMap } from "rxjs"
import type { LivequeryStorge } from "./LivequeryStorge"
import type { LivequeryQueryResult, LivequeryTransporter } from "./LivequeryTransporter"
import type { DataChangeEvent, LivequeryAction, LivequeryDocument, LivequeryQueryParams } from "./types"
import { matchesAllFilters } from "./helpers/filterLivequeryDocuments"




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

export type SyncRequest<T extends LivequeryDocument> = LivequeryAction<T> & {
    id: string
    ref: string,
    collection_ref: string
    source: 'query' | 'realtime' | 'action'
}


export type ConflictResolverFunction = <T extends LivequeryDocument>(e: {
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
                            return matchesAllFilters(change.data as any as LivequeryDocument, filters || {})
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

    watch<T extends LivequeryDocument>(ref: string, collection_id: string) {
        return new Observable<Partial<LivequeryQueryResult<T>>>(o => {
            this.#collections.set(collection_id, {
                o,
                ref
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

    async query<T extends LivequeryDocument>(req: LivequeryQueryParams<T>) {
        setTimeout(() => this.#queries$.next(req), 0)
        return await this.config.storage.query<T>(req.ref, req.filters)
    }



    async #broadcast<T extends LivequeryDocument>({ source, ref, collection_ref, action, payload, id }: SyncRequest<T>) {
        const collections = this.#refs.get(ref)
        if (!collections) return {}

        const change = await (async () => {
            if (action == 'add') {
                return {
                    id,
                    type: 'added' as DataChangeEvent<any>['type'],
                    data: await this.config.storage.add<T>(
                        collection_ref,
                        {
                            ...payload,
                            id,
                        } as T
                    )
                }
            }
            if (action == 'update') {
                return {
                    id,
                    type: 'updated' as DataChangeEvent<any>['type'],
                    data: await this.config.storage.update<T>(
                        collection_ref,
                        id,
                        payload || {}
                    )
                }
            }
            if (action == 'delete') {
                return {
                    id,
                    type: 'removed' as DataChangeEvent<any>['type'],
                    data: await this.config.storage.delete<T>(
                        collection_ref,
                        id
                    )
                }
            }
        })();
        if (!change) return {}
        for (const collection_id of collections) {
            const sender = this.#collections.get(collection_id)
            if (!sender) continue
            sender.o.next({
                changes: [change],
                from: source
            })
        }
        return change.data as T
    }

    async #sync(ref: string, collection_ref: string, doc: Record<string, any>) {
        return EMPTY
        if (doc.id.startsWith('local:')) {
            // Try to sync to at least one transporter to get a real id
            // Sync to collections

        }

        // Sync to all remote transporters
        for (const transporter of Object.values(this.config.transporters)) {

        }

    }

    trigger<T extends LivequeryDocument>(action: LivequeryAction<T>) {

        const options = this.#collections.get(action.collection_id)
        if (!options) throw new Error(`Collection with id ${action.collection_id} not found (maybe disconnected)`)

        const refs = action.ref.split('/')
        const collection_ref = refs.length % 2 == 0 ? refs.slice(0, -1).join('/') : action.ref
        const id = refs.length % 2 == 0 ? refs[refs.length - 1] || '' : ''
        return from(
            this.#broadcast({
                ...action,
                id,
                collection_ref,
                source: 'action'
            })
        ).pipe(
            switchMap(change => {
                if (['add', 'update', 'delete'].includes(action.action)) {
                    return from(this.#sync(action.ref, collection_ref, change)).pipe(
                        mergeMap($ => $)
                    )
                }
                return from(Object.entries(this.config.transporters)).pipe(
                    mergeMap(([id, transporter]) => transporter.trigger<T>(action))
                )
            })
        )
    }


}