import { BehaviorSubject, defer, map, Subscription, tap } from "rxjs"
import type { LivequeryCore, LivequeryFilters, LivequeryLoadingState, LivequeryWatchOptions } from "./LivequeryCore"
import type { LivequeryAction, LivequeryDocument } from "./LivequeryTransporter"



export type LivequeryCollectionState<T extends LivequeryDocument> = {
    ref: string
    items: T[]
    summary: Record<string, any>
    metadata?: Record<string, any>
    loading: LivequeryLoadingState
    filters?: Record<string, any>
}


export class LivequeryCollection<T extends LivequeryDocument> extends BehaviorSubject<LivequeryCollectionState<T>> {

    #linker: Subscription
    constructor(
        private core: LivequeryCore,
        private options: LivequeryWatchOptions
    ) {
        super({
            ref: options.ref,
            items: [],
            summary: {},
            filters: options.filters,
            loading: {
                all: options.lazy ? false : true,
                next: options.lazy ? false : true,
                prev: false
            }
        })
        this.#linker = defer(() => this.core.watch<T>(options).pipe(
             map(event => {
                const value = this.value
                
                // merge logic here 


                return {} as any as LivequeryCollectionState<T>
             }),
        )).subscribe(e => this.next(e))
    }

    query(filters: LivequeryFilters) {
        return this.core.query(filters, true)
    }

    loadMore() {
        return this.core.query(this.value.filters || {}, false)
    }


    loadPrev() {
        return this.core.query(this.value.filters || {}, false)
    }

    add(payload: Partial<T>) {
        return this.core.trigger({
            action: 'add',
            payload,
            ref: this.options.ref
        })
    }


    update(id: string, payload: Partial<T>) {
        return this.core.trigger({
            action: 'update',
            payload: {
                id,
                ...payload
            },
            ref: this.options.ref
        })
    }


    delete(id: string) {
        return this.core.trigger({
            action: 'delete',
            payload: {
                id
            },
            ref: this.options.ref
        })
    }

    trigger(action: LivequeryAction) {
        return this.core.trigger({
            ...action,
            ref: this.options.ref
        })
    }


    override unsubscribe() {
        super.unsubscribe();
        this.#linker.unsubscribe()
    }

}