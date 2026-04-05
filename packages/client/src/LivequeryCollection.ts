import { BehaviorSubject, filter, firstValueFrom, map, Subscription, tap } from "rxjs"
import { LivequeryCore, type LivequeryLoadingState } from "./LivequeryCore"
import type { DataChangeEvent, LivequeryAction, LivequeryDocument, LivequeryFilters, LivequeryPaging } from "./types"



export type LivequeryCollectionOptions<T extends LivequeryDocument> = {
    core: LivequeryCore,
    ref: string
    filters: LivequeryFilters<T>
    lazy?: boolean
}

export class LivequeryCollection<T extends LivequeryDocument> {

    #id = crypto.randomUUID()
    #query_id = '#'
    #keys = new Set<keyof T>()
    #linker: Subscription
    #indexes: Map<string, number>

    public readonly ref: string
    public readonly items: BehaviorSubject<Array<BehaviorSubject<T>>>
    public readonly summary: BehaviorSubject<Record<string, any>>
    public readonly metadata: BehaviorSubject<Record<string, any>>
    public readonly loading: BehaviorSubject<LivequeryLoadingState>
    public readonly filters: BehaviorSubject<Partial<LivequeryFilters<T>>>
    public readonly paging: BehaviorSubject<LivequeryPaging>



    constructor(private options: LivequeryCollectionOptions<T>) {
        this.ref = options.ref
        this.#indexes = new Map()
        this.items = new BehaviorSubject<Array<BehaviorSubject<T>>>([])
        this.summary = new BehaviorSubject({})
        this.loading = new BehaviorSubject<LivequeryLoadingState>({
            all: options.lazy ? false : true,
            next: options.lazy ? false : true,
            prev: false
        })
        this.filters = new BehaviorSubject<Partial<LivequeryFilters<T>>>(options.filters)
        this.paging = new BehaviorSubject<LivequeryPaging>({
            total: 0,
            current: 0
        })
    }

    initialize() {
        if (this.options.lazy) return
        if (typeof window == 'undefined') return
        if (!this.options.core) return
        if (this.#linker) return
        this.#linker = this.options.core.watch<T>(this.options.ref, this.#id).pipe(
            filter(e => e.source == 'query' ? e.query_id === this.#query_id : true),
            tap(event => {
                event.summary && this.summary.next(event.summary)
                event.metadata && this.metadata.next(event.metadata)
                if (!event.changes || event.changes.length == 0) return

                const chaos = event.changes && event.changes.some(change => {
                    if (change.type == 'added' || change.type == 'removed') return true
                    return Object.keys(change.data || {}).some(k => this.#keys.has(k as keyof T))
                }) 



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

                const events = event.changes.reduce((p, c) => {
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
                    const index = this.#indexes.get(id)
                    const target = index != undefined && index >= 0 ? p[index] : null
                    target && target.next({ ...target.value, ...data })
                    return p
                }, this.items.value)


                const items = events.removed.reduce((p, { id }) => {
                    const index = this.#indexes.get(id)
                    if (index != undefined) {
                        return [
                            ...p.slice(0, index),
                            ...p.slice(index + 1)
                        ]
                    }
                    return p
                }, [
                    ...updated_items,
                    ...(
                        events.added
                            .filter(a => a.data)
                            .map(d => new BehaviorSubject({ id: d.id, ...d.data } as any as T))
                    )
                ]).sort(sorter)

                this.#indexes = items.reduce((p, c, index) => {
                    p.set(c.value.id, index)
                    return p
                }, new Map<string, number>())


                this.items.next(items)
                this.loading.next({
                    all: false,
                    next: false,
                    prev: false
                })
                event.paging && this.paging.next(event.paging)
            })
        ).subscribe()
        return this.#linker
    }

    async #query(query_id: string, filters: Partial<LivequeryFilters<T>>) {
        this.#keys = new Set(Object.keys(filters).filter(a => a.includes(':sort')).map(k => k.split(':')[0] as keyof T))
        const result = await this.options.core.query<T>({
            query_id,
            ref: this.options.ref,
            filters,
            collection_id: this.#id
        })
        const documents = result.documents || []
        const items = documents.map(doc => new BehaviorSubject(doc))
        this.filters.next(filters)
        this.items.next(items)
        this.loading.next({
            all: false,
            next: !!result.paging?.next,
            prev: !!result.paging?.prev
        })
        result.paging && this.paging.next(result.paging)
    }

    async query(filters: Partial<LivequeryFilters<T>>) {
        await this.#query(`all:${Date.now().toString(36)}`, filters)
    }

    async loadMore() {
        const next = this.paging.value.next
        if (!next) return
        const id = `after:${Date.now().toString(36)}`
        const filters = {
            ...this.filters.value,
            ':after': next.cursor
        }
        await this.#query(id, filters || {})
    }


    async loadPrev() {
        const prev = this.paging.value.prev
        if (!prev) return
        const id = `before:${Date.now().toString(36)}`
        const filters = {
            ...this.filters.value,
            ':before': prev.cursor
        }
        await this.#query(id, filters || {})
    }

    async loadAround(cursor: string) {
        const id = `all:${Date.now().toString(36)}`
        const filters = {
            ...this.filters.value,
            ':after': cursor,
            ':before': cursor
        }
        await this.#query(id, filters || {})
    }

    add(payload: Partial<T>) {
        return firstValueFrom(this.options.core.trigger({
            action: 'add',
            payload,
            ref: this.options.ref,
            collection_id: this.#id
        }))
    }


    update(id: string, payload: Partial<T>) {
        return firstValueFrom(this.options.core.trigger({
            action: 'update',
            payload: {
                id,
                ...payload
            },
            ref: this.options.ref,
            collection_id: this.#id
        }))
    }


    delete(id: string) {
        return firstValueFrom(this.options.core.trigger({
            action: 'delete',
            payload: {
                id
            },
            ref: this.options.ref,
            collection_id: this.#id
        }))
    }

    trigger(action: LivequeryAction<T>['action'], payload?: LivequeryAction<T>['payload']) {
        return this.options.core.trigger({
            action,
            payload,
            ref: this.options.ref,
            collection_id: this.#id
        })
    }
}