import { BehaviorSubject, defer, map, Subscription } from "rxjs"
import type { LivequeryLoadingState } from "./LivequeryCore"
import { WorkerRpc } from "./helpers/WorkerRpc"
import type { LivequeryAction, LivequeryDocument, LivequeryFilters } from "./types"





export type LivequeryCollectionState<T extends LivequeryDocument> = {
    ref: string
    items: T[]
    summary: Record<string, any>
    metadata?: Record<string, any>
    loading: LivequeryLoadingState
    filters?: Record<string, any>
}


export class LivequeryCollection<T extends LivequeryDocument> extends BehaviorSubject<LivequeryCollectionState<T>> {

    #core = WorkerRpc.linkCore()

    #linker: Subscription
    constructor(private options: { ref: string, filters: LivequeryFilters<T>, lazy: true }) {
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
        this.#linker = defer(() => this.#core.watch<T>(options.ref).pipe(
            map(event => {
                const value = this.value

                // merge logic here 


                return {} as any as LivequeryCollectionState<T>
            }),
        )).subscribe(e => this.next(e))
    }

    query(filters: LivequeryFilters<T>) {
        this.options.filters = filters
        return this.#core.query(this.options)
    }

    loadMore() {
        return this.#core.query(this.options)
    }


    loadPrev() {
        return this.#core.query(this.options)
    }

    add(payload: Partial<T>) {
        return this.#core.trigger({
            action: 'add',
            payload,
            ref: this.options.ref
        })
    }


    update(id: string, payload: Partial<T>) {
        return this.#core.trigger({
            action: 'update',
            payload: {
                id,
                ...payload
            },
            ref: this.options.ref
        })
    }


    delete(id: string) {
        return this.#core.trigger({
            action: 'delete',
            payload: {
                id
            },
            ref: this.options.ref
        })
    }

    trigger(action: LivequeryAction<T>['action'], payload?: LivequeryAction<T>['payload']) {
        return this.#core.trigger({
            action,
            payload,
            ref: this.options.ref
        })
    }


    override unsubscribe() {
        super.unsubscribe();
        this.#linker.unsubscribe()
    }

}