import { BehaviorSubject, Observable, Subscription, tap } from "rxjs"
import { LivequeryCore, type LivequeryLoadingState } from "./LivequeryCore"
import type { DataChangeEvent, Doc, DocState, LivequeryFilters, LivequeryPaging } from "./types"
import { LivequeryDocument } from "./LivequeryDocument"



export type LivequeryCollectionOptions<T extends Doc> = {
    core?: LivequeryCore | false | '' | 0 | null | undefined,
    ref: string
    filters: LivequeryFilters<T>
    lazy?: boolean
    full?: boolean
}

export class LivequeryCollection<T extends Doc> {

    #id = crypto.randomUUID()
    #keys = new Map<keyof T, number>()
    #linker: Subscription
    #indexes: Map<string, number>

    public readonly ref: string

    public readonly items: BehaviorSubject<LivequeryDocument<DocState<T>>[]>
    public readonly summary: BehaviorSubject<Record<string, any>>
    public readonly metadata: BehaviorSubject<Record<string, any>>
    public readonly loading: BehaviorSubject<LivequeryLoadingState>
    public readonly filters: BehaviorSubject<Partial<LivequeryFilters<T>>>
    public readonly paging: BehaviorSubject<LivequeryPaging>



    constructor(private options: LivequeryCollectionOptions<T>) {
        this.ref = options.ref
        this.#indexes = new Map()
        this.items = new BehaviorSubject<LivequeryDocument<DocState<T>>[]>([])
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
        if (typeof window == 'undefined') return
        if (!this.options.core) return
        if (this.#linker) return
        this.#linker = this.options.core.watch<T>(this.options.ref, this.#id).pipe(
            tap(event => {
                event.summary && this.summary.next(event.summary)
                event.metadata && this.metadata.next(event.metadata)
                event.paging && this.paging.next(event.paging)

                if (!event.changes || event.changes.length == 0) return
                const chaos = event.changes && event.changes.some(change => {
                    if (change.type == 'added' || change.type == 'removed') return true
                    return Object.keys(change.data || {}).some(k => this.#keys.has(k as keyof T))
                })
                const sorter = (a: BehaviorSubject<T>, b: BehaviorSubject<T>) => {
                    for (const [key, order] of this.#keys) {
                        const va = a.value[key]
                        const vb = b.value[key]
                        if (typeof va === 'number' && typeof vb === 'number') {
                            if (va < vb) return -order
                            if (va > vb) return order
                        }
                        if (typeof va === 'string' && typeof vb === 'string') {
                            if (va < vb) return -order
                            if (va > vb) return order
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
                            .map(d => new LivequeryDocument(this, { id: d.id, ...d.data } as any as T))
                    )
                ]).sort(sorter)

                this.#indexes = items.reduce((p, c, index) => {
                    p.set(c.value.id, index)
                    return p
                }, new Map<string, number>())


                chaos && this.items.next(items)
                this.loading.next({
                    all: false,
                    next: false,
                    prev: false
                })
                event.paging && this.paging.next(event.paging)
            })
        ).subscribe()

        !this.options.lazy && this.query(this.options.filters || {})
        return this.#linker
    }

    async #query(filters: Partial<LivequeryFilters<T>>) {
        if (!this.options.core) return
        this.#keys = Object.entries(filters).reduce((p, [k, v]) => {
            if (k.endsWith(':sort')) {
                const field = k.split(':')[0] as keyof T
                p.set(field, v === 'asc' ? 1 : -1)
            }
            return p
        }, new Map<keyof T, number>())
        const result = await this.options.core.query<T>({
            ref: this.options.ref,
            filters,
            collection_id: this.#id
        })
        const documents = result.documents || []
        const items = documents.map(doc => new LivequeryDocument(this, doc))
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
        this.loading.next({
            all: true,
            next: false,
            prev: false
        })
        await this.#query(filters)
    }

    async loadMore() {
        const next = this.paging.value.next
        if (!next) return
        const filters = {
            ...this.filters.value,
            ':after': next.cursor
        }
        this.loading.next({
            all: false,
            next: true,
            prev: false
        })
        await this.#query(filters || {})
    }


    async loadPrev() {
        const prev = this.paging.value.prev
        if (!prev) return
        const filters = {
            ...this.filters.value,
            ':before': prev.cursor
        }
        this.loading.next({
            all: false,
            next: false,
            prev: true
        })
        await this.#query(filters || {})
    }

    async loadAround(cursor: string) {
        const filters = {
            ...this.filters.value,
            ':after': cursor,
            ':before': cursor
        }
        this.loading.next({
            all: false,
            next: true,
            prev: true
        })
        await this.#query(filters || {})
    }

    add(payload: Partial<T>) {
        if (!this.options.core) throw new Error('LivequeryCollection is not initialized with a core instance')
        return this.options.core.add<T>(this.options.ref, payload)
    }


    update(id: string, payload: Partial<T>) {
        if (!this.options.core) throw new Error('LivequeryCollection is not initialized with a core instance')
        return this.options.core.update<T>(this.options.ref, id, payload)
    }


    delete(id: string) {
        if (!this.options.core) throw new Error('LivequeryCollection is not initialized with a core instance')
        return this.options.core.delete<T>(this.options.ref, id)
    }

    trigger<T>(action: string, payload?: Record<string, any>) {
        if (!this.options.core) throw new Error('LivequeryCollection is not initialized with a core instance')
        return this.options.core.trigger<T>({
            action,
            payload,
            ref: this.options.ref
        }) as Observable<{ data: T, error?: Error }>
    }
}