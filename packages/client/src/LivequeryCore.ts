import { EMPTY, finalize, from, Subscription, map, merge, mergeAll, mergeMap, Observable, of, Subject, Subscriber } from "rxjs"
import type { LivequeryStorge } from "./LivequeryStorge"
import type { DataChangeEvent, LivequeryQueryResult, LivequeryTransporter } from "./LivequeryTransporter"
import { WorkerRpc } from "./helpers/WorkerRpc"
import type { LivequeryAction, LivequeryDocument, LivequeryFilters, LivequeryQueryParams } from "./types"





export type LivequeryCoreOptions = {
    transporters: Record<string, LivequeryTransporter>
    storage: LivequeryStorge
}

export type LivequeryLoadingState = {
    next: boolean
    prev: boolean
    all: boolean
}

export type CollectionStreamEvent<T extends LivequeryDocument> = LivequeryQueryResult<T> & {
    loading: LivequeryLoadingState
}

type CollectionId = string



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
        o: Subscriber<CollectionStreamEvent<any>>
    }>()


    #queries$ = new Subject<LivequeryQueryParams<any> & { collection_id: string }>()


    constructor(private readonly config: LivequeryCoreConfig) {
        // Init here
    }

    watch<T extends LivequeryDocument>(ref: string) {
        const collection_id = WorkerRpc.getSenderId.call(this)
        return new Observable<CollectionStreamEvent<T>>(o => {
            this.#collections.set(collection_id, {
                o,
                ref
            })
            return () => {
                this.#collections.delete(collection_id)
            }
        })
    }

    async query<T extends LivequeryDocument>(req: LivequeryQueryParams<T>) {
        const collection_id = WorkerRpc.getSenderId.call(this)
        setTimeout(() => this.#queries$.next({
            ...req,
            collection_id
        }), 0)
        return await this.config.storage.query(req.ref, req.filters) || []
    }

    trigger<T extends LivequeryDocument>(action: LivequeryAction<T>) {
        const collection_id = WorkerRpc.getSenderId.call(this)
        const options = this.#collections.get(collection_id)
        if (!options) throw new Error(`Collection with id ${collection_id} not found (maybe disconnected)`)
        return EMPTY as Observable<T>
    }


}