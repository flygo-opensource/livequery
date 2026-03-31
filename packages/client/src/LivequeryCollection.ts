import { BehaviorSubject, filter, map, Subscription, tap } from "rxjs"
import { LivequeryCore, type LivequeryLoadingState } from "./LivequeryCore"
import type { DataChangeEvent, LivequeryAction, LivequeryDocument, LivequeryFilters, LivequeryPaging } from "./types"




export type LivequeryCollectionState<T extends LivequeryDocument> = {
    ref: string
    indexes: Map<string, number>
    items: Array<BehaviorSubject<T>>
    summary: Record<string, any>
    metadata?: Record<string, any>
    loading: LivequeryLoadingState
    filters?: Partial<LivequeryFilters<T>>
    paging: LivequeryPaging
}



export class LivequeryCollection<T extends LivequeryDocument> extends BehaviorSubject<LivequeryCollectionState<T>> {

    #id = crypto.randomUUID()
    #query_id = '...'
    #keys = new Set<keyof T>()
    #linker: Subscription


    constructor(
        private core: LivequeryCore,
        private options: { ref: string, filters: LivequeryFilters<T>, lazy: true }
    ) {
        super({
            ref: options.ref,
            indexes: new Map(),
            items: [],
            summary: {},
            filters: options.filters,
            loading: {
                all: options.lazy ? false : true,
                next: options.lazy ? false : true,
                prev: false
            },
            paging: {
                total: 0,
                current: 0
            }
        })
        this.#linker = this.core.watch<T>(options.ref, this.#id).pipe(
            filter(e => e.query_id === this.#query_id),
            tap(event => {
                const value = this.value
                const chaos = event.changes && event.changes.some(change => {
                    if (change.type == 'added') return true
                    return Object.keys(change.data).some(k => this.#keys.has(k as keyof T))
                })
                const changes = event.changes
                if (!chaos || !changes || changes.length == 0) return

                const mapper = (d: DataChangeEvent<T>) => new BehaviorSubject({ id: d.data.id, ...d.data } as any as T)
                const sorter = (a: BehaviorSubject<T>, b: BehaviorSubject<T>) => {
                    for (const key of this.#keys) {
                        const va = a.value[key]
                        const vb = b.value[key]
                        if (typeof va === 'number' && typeof vb === 'number') {
                            if (va < vb) return -1
                            if (va > vb) return 1
                        }
                        if (typeof va === 'string' && typeof vb === 'string') {
                            if (va < vb) return -1
                            if (va > vb) return 1
                        }
                    }
                    return 0
                }

                const events = changes.reduce((p, c) => {
                    return {
                        ...p,
                        [c.type]: [
                            ...p[c.type],
                            c
                        ]
                    }
                }, {
                    added: [],
                    updated: [],
                    removed: []
                } as {
                    [type in DataChangeEvent<T>['type']]: DataChangeEvent<T>[]
                })

                const updated_items = events.updated.reduce((p, { data, id }) => {
                    const index = this.value.indexes.get(id)
                    const target = index != undefined && index >= 0 ? p[index] : null
                    target && target.next({ ...target.value, ...data })
                    return p
                }, this.value.items)

                const items = events.removed.reduce((p, { id }) => {
                    const index = this.value.indexes.get(id)
                    if (index != undefined) {
                        return [
                            ...p.slice(0, index),
                            ...p.slice(index + 1)
                        ]
                    }
                    return p
                }, [
                    ...updated_items,
                    ...events.added.map(mapper),
                ]).sort(sorter)

                const indexes = items.reduce((p, c, index) => {
                    p.set(c.value.id, index)
                    return p
                }, new Map<string, number>)

                this.next({
                    ... this.value,
                    items,
                    indexes,
                    ...event.metadata ? { metadata: event.metadata } : {},
                    ...event.summary ? { summary: event.summary } : {},
                    loading: {
                        all: false,
                        next: false,
                        prev: false
                    },
                    paging: event.paging || value.paging
                })
            })
        ).subscribe()
    }


    async #query(query_id: string, filters: Partial<LivequeryFilters<T>>) {
        this.#keys = new Set(Object.keys(filters).filter(a => a.includes(':sort')).map(k => k.split(':')[0] as keyof T))
        const result = await this.core.query<T>({
            query_id,
            ref: this.options.ref,
            filters,
            collection_id: this.#id
        })
        const documents = result.documents || []
        const items = documents.map(doc => new BehaviorSubject(doc))
        this.next({
            ... this.value,
            filters,
            items,
            loading: {
                all: true,
                next: !!result.paging?.next,
                prev: !!result.paging?.prev
            },
            paging: result.paging || this.value.paging
        })
    }

    async query(filters: Partial<LivequeryFilters<T>>) {
        await this.#query(`all:${Date.now().toString(36)}`, filters)
    }

    async loadMore() {
        const next = this.value.paging.next
        if (!next) return
        const id = `after:${Date.now().toString(36)}`
        const filters = {
            ...this.value.filters,
            ':after': next.cursor
        }
        await this.#query(id, filters || {})
    }


    async loadPrev() {
        const prev = this.value.paging.prev
        if (!prev) return
        const id = `before:${Date.now().toString(36)}`
        const filters = {
            ...this.value.filters,
            ':before': prev.cursor
        }
        await this.#query(id, filters || {})
    }

    async loadAround(cursor: string) {
        const id = `all:${Date.now().toString(36)}`
        const filters = {
            ...this.value.filters,
            ':after': cursor,
            ':before': cursor
        }
        await this.#query(id, filters || {})
    }

    add(payload: Partial<T>) {
        return this.core.trigger({
            action: 'add',
            payload,
            ref: this.options.ref,
            collection_id: this.#id
        })
    }


    update(id: string, payload: Partial<T>) {
        return this.core.trigger({
            action: 'update',
            payload: {
                id,
                ...payload
            },
            ref: this.options.ref,
            collection_id: this.#id
        })
    }


    delete(id: string) {
        return this.core.trigger({
            action: 'delete',
            payload: {
                id
            },
            ref: this.options.ref,
            collection_id: this.#id
        })
    }

    trigger(action: LivequeryAction<T>['action'], payload?: LivequeryAction<T>['payload']) {
        return this.core.trigger({
            action,
            payload,
            ref: this.options.ref,
            collection_id: this.#id
        })
    }


    override unsubscribe() {
        super.unsubscribe();
        this.#linker.unsubscribe()
    }

}