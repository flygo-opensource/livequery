import { EMPTY, from, map, mergeMap, Observable, Subject, Subscriber, switchMap } from "rxjs"
import type { LivequeryStorge } from "./LivequeryStorge"
import type { LivequeryQueryResult, LivequeryTransporter } from "./LivequeryTransporter"
import type { DataChangeEvent, LivequeryAction, LivequeryDocument, LivequeryQueryParams } from "./types"
import { matchesAllFilters } from "./helpers/filterLivequeryDocuments"
import { uuidv7 } from 'uuidv7'




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



export type ConfigResolverFunction = <T extends LivequeryDocument>(e: {
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
    resolver: ConfigResolverFunction
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

    trigger<T extends LivequeryDocument>(action: LivequeryAction<T>) {
        const options = this.#collections.get(action.collection_id)
        if (!options) throw new Error(`Collection with id ${action.collection_id} not found (maybe disconnected)`)
        const trigger = () => from(Object.entries(this.config.transporters)).pipe(
            mergeMap(([id, transporter]) => transporter.trigger<T>(action))
        )
        if (action.action === 'add') {
            const id = `local:${uuidv7()}`
            return from(this.config.storage.add(
                action.ref,
                { ...action.payload, id } as T)
            ).pipe(
                mergeMap(async result => {
                    const doc = result.data
                    if (doc && doc.id) {
                        this.config.storage.update(action.ref, id, doc)
                    }
                    return result
                })
            )
        }

        const id = action.payload?.id
        if (!id) throw new Error(`Missing document id for update/delete action`)

        if (action.action === 'update') { 
            return from(this.config.storage.update(action.ref, id, action.payload as T)).pipe(
                switchMap(trigger)
            )
        }

        if (action.action === 'delete') { 
            return from(this.config.storage.delete(action.ref, id)).pipe(
                switchMap(trigger)
            )
        }

        return from(Object.entries(this.config.transporters)).pipe(
            mergeMap(trigger)
        )
    }


}