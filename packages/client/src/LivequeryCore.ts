import { EMPTY, finalize, from, map, merge, mergeAll, mergeMap, Observable, of, Subject } from "rxjs"
import type { LivequeryStorge } from "./LivequeryStorge"
import type { LivequeryAction, LivequeryDocument, LivequeryQueryResult, LivequeryTransporter } from "./LivequeryTransporter"
import { WorkerRpc } from "./helpers/WorkerRpc"

export type LivequeryFilter = Partial<{
    gt: number | string
    gte: number | string
    lt: number | string
    lte: number | string
    eq: number | string
    ne: number | string
    in: (number | string)[]
    nin: (number | string)[]
}>


export type LivequeryFilters = Record<string, LivequeryFilter>

export type CollectionQuery = {
    action: 'get' | 'create' | 'update' | 'delete' | 'query' | `~${string}`
    payload?: Record<string, any>
    query?: LivequeryFilters
    headers?: Record<string, any>
}




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

export type LivequeryWatchOptions = {
    ref: string
    filters: LivequeryFilters
    lazy?: boolean
    headers?: () => Promise<Record<string, any>>
}

type CollectionId = string

export class LivequeryCore {

    #collections = new Map<CollectionId, LivequeryWatchOptions & {
        $: Subject<CollectionStreamEvent<any>>
    }>()
    #refs = new Map<string, Set<CollectionId>>()

    constructor(private options: LivequeryCoreOptions) {
        // Init here
    }

    watch<T extends LivequeryDocument>(options: LivequeryWatchOptions) {
        // create a subject for this collection 
    }

    query(filters: LivequeryFilters, reset: boolean) {
        // Return first value from cache as soon as possible
        // Trigger query to get real data
        // Listen for realtime data

    }

    trigger<T>(action: LivequeryAction) {
        const collection_id = WorkerRpc.getSenderId.call(this)
        return EMPTY as Observable<T>
    }



}