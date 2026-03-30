import { EMPTY, from, map, mergeMap, Observable, Subject, Subscriber } from "rxjs"
import type { LivequeryStorge } from "./LivequeryStorge"
import type { LivequeryQueryResult, LivequeryTransporter } from "./LivequeryTransporter"
import type { DataChangeEvent, LivequeryAction, LivequeryDocument, LivequeryQueryParams } from "./types"





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
            from: 'query' | 'realtime'
        }>
    }>()
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
                        sender.o.next({
                            ...result,
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
            return () => {
                this.#collections.delete(collection_id)
            }
        })
    }

    async query<T extends LivequeryDocument>(req: LivequeryQueryParams<T>) {
        setTimeout(() => this.#queries$.next(req), 0)
        return await this.config.storage.query<T>(req.ref, req.filters) || []
    }

    trigger<T extends LivequeryDocument>(action: LivequeryAction<T>) {
        const options = this.#collections.get(action.collection_id)
        if (!options) throw new Error(`Collection with id ${action.collection_id} not found (maybe disconnected)`)
        return from(Object.entries(this.config.transporters)).pipe(
            mergeMap(([id, transporter]) => transporter.trigger<T>(action))
        )
    }


}