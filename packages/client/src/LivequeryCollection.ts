import { BehaviorSubject, debounceTime, EMPTY, filter, finalize, merge, Observable, pairwise, Subject, Subscription, switchMap, tap } from "rxjs"
import { LivequeryCore, type LivequeryLoadingState } from "./LivequeryCore"
import type { DataChangeEvent, Doc, DocState, LivequeryFilters, LivequeryPaging } from "./types"
import { LivequeryDocument } from "./LivequeryDocument"



export type LivequeryCollectionOptions<T extends Doc> = {
    filters?: Partial<LivequeryFilters<T>>
    lazy?: boolean
    full?: boolean
    debounce?: number
}

export class LivequeryCollection<T extends Doc> {

    public readonly id = (Math.random() * 1e18).toString(36)
    #keys = new Map<keyof T, number>()
    #indexes: Map<string, number>
    #core: LivequeryCore | undefined
    #filters = new Subject<Partial<LivequeryFilters<T>>>()

    public ref: string

    public readonly items: BehaviorSubject<LivequeryDocument<DocState<T>>[]>
    public readonly summary: BehaviorSubject<Record<string, any>>
    public readonly metadata: BehaviorSubject<Record<string, any>>
    public readonly loading: BehaviorSubject<LivequeryLoadingState | null>
    public readonly filters: BehaviorSubject<Partial<LivequeryFilters<T>>>
    public readonly paging: BehaviorSubject<LivequeryPaging>
    public readonly error: BehaviorSubject<{ code: string, message: string } | null>

    private options: LivequeryCollectionOptions<T>

    constructor(options: LivequeryCollectionOptions<T>) {
        this.#indexes = new Map()
        this.items = new BehaviorSubject<LivequeryDocument<DocState<T>>[]>([])
        this.summary = new BehaviorSubject({})
        this.loading = new BehaviorSubject<LivequeryLoadingState>(null)
        this.filters = new BehaviorSubject<Partial<LivequeryFilters<T>>>(options?.filters || {})
        this.paging = new BehaviorSubject<LivequeryPaging>({
            total: 0,
            current: 0
        })
        this.error = new BehaviorSubject<{ code: string, message: string } | null>(null)
        if (options) {
            this.options = options
        }
    }

    #reindex() {
        this.#indexes = this.items.value.reduce((p, c, index) => {
            p.set(c.value.id, index)
            return p
        }, new Map<string, number>())
    }


    #subscription: Subscription | null = null
    initialize(core: LivequeryCore, ref: string) {
        if (typeof window == 'undefined') return
        this.ref = ref
        this.#core = core
        const timer = this.options.lazy !== true && setTimeout(() => this.query(this.filters.value || {}))
        this.#subscription?.unsubscribe()
        this.#subscription = merge(
            this.options.debounce ? this.#filters.pipe(
                debounceTime(this.options.debounce),
                switchMap(filters => this.query(filters))
            ) : EMPTY,

            core.watch(this.ref, this.id).pipe(
                finalize(() => {
                    timer && clearTimeout(timer)
                }),
                tap(event => {
                    event.summary && this.summary.next(event.summary)
                    event.metadata && this.metadata.next(event.metadata)
                    event.paging && this.paging.next(event.paging)
                    event.error && this.error.next(event.error)

                    if (!event.changes || event.changes.length == 0) {
                        event.from == 'query' && this.loading.next(null)
                        return
                    }
                    const chaos = event.changes && event.changes.some(change => {
                        if (change.type == 'added' || change.type == 'removed') return true
                        if (change.data && change.data.id != change.id) return true
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
                                ...(p[c.type] || []),
                                c
                            ]
                        }
                    }, {
                        added: [] as DataChangeEvent[],
                        modified: [] as DataChangeEvent[],
                        removed: [] as DataChangeEvent[]
                    })

                    const updated_items = events.modified.reduce((p, { data, id }) => {
                        const index = this.#indexes.get(id)
                        const target = index != undefined && index >= 0 ? p[index] : null
                        target && target.next({ ...target.value, ...data })
                        return p
                    }, this.items.value)

                    const new_items = (
                        events.added
                            .filter(a => a.data)
                            .reduce(
                                (p, c) => {
                                    if (!p.indexes.has(c.id)) {
                                        const doc = new LivequeryDocument(this, { id: c.id, ...c.data } as any as T)
                                        p.list.push(doc)
                                        p.indexes.add(c.id)
                                    }
                                    return p
                                },
                                {
                                    list: [] as LivequeryDocument<DocState<T>>[],
                                    indexes: new Set(this.#indexes.keys())
                                }
                            )
                    )

                    const remove_indexes = (
                        events.removed
                            .map(r => this.#indexes.get(r.id))
                            .filter(i => i != undefined)
                            .sort((a, b) => b - a)
                    )

                    const unsort_items = remove_indexes.reduce((p, index) => {
                        return [
                            ...p.slice(0, index),
                            ...p.slice(index + 1)
                        ]
                    }, [
                        ...updated_items,
                        ...new_items.list
                    ])

                    const items = chaos ? unsort_items.sort(sorter) : unsort_items
                    if (chaos) {
                        this.items.next(items)
                        this.#reindex()
                    }
                    event.from == 'query' && this.loading.next(null)
                    event.paging && this.paging.next(event.paging)
                    event.from == 'query' && this.loading.next(null)
                }),
            )
        ).subscribe()
        return this.#subscription
    }

    async #query(filters: Partial<LivequeryFilters<T>>, flush: boolean) {
        if (!this.#core) return
        this.error.next(null)
        flush && this.items.next([])
        this.#keys = Object.entries(filters).reduce((p, [k, v]) => {
            if (k.endsWith(':sort')) {
                const field = k.split(':')[0] as keyof T
                p.set(field, v === 'asc' ? 1 : -1)
            }
            return p
        }, new Map<keyof T, number>())
        this.filters.next(filters)
        const next = filters[':after']
        const prev = filters[':before']
        const loading = next && prev ? 'all' : next ? 'next' : prev ? 'prev' : 'all'
        this.loading.next(loading)
        await this.#core.query<T>({
            ref: this.ref,
            filters,
            collection_id: this.id
        })
        // const documents = result.documents || []
        // const items = documents.map(doc => new LivequeryDocument(this, doc))
        // this.items.next(items)
        // this.#reindex()
        // result.paging && this.paging.next(result.paging)
    }

    async query(filters: Partial<LivequeryFilters<T>>) {
        this.loading.next('all')
        await this.#query(filters, true)
    }

    async debounceQuery(filters: Partial<LivequeryFilters<T>>) {
        this.#filters.next(filters)
    }

    async loadMore() {
        const next = this.paging.value.next
        if (!next) return
        const filters = {
            ...this.filters.value,
            ':after': next.cursor
        }
        this.loading.next('next')
        await this.#query(filters || {}, false)
    }


    async loadPrev() {
        const prev = this.paging.value.prev
        if (!prev) return
        const filters = {
            ...this.filters.value,
            ':before': prev.cursor
        }
        this.loading.next('prev')
        await this.#query(filters || {}, false)
    }

    async loadAround(cursor: string) {
        const filters = {
            ...this.filters.value,
            ':after': cursor,
            ':before': cursor
        }
        this.loading.next('all')
        await this.#query(filters || {}, false)
    }

    add(payload: Partial<T>) {
        if (!this.#core) throw new Error('LivequeryCollection is not initialized with a core instance')
        return this.#core.add<T>(this.ref, payload)
    }


    update(id: string, payload: Partial<T>) {
        if (!this.#core) throw new Error('LivequeryCollection is not initialized with a core instance')
        return this.#core.update<T>(this.ref, id, payload)
    }


    delete(id: string) {
        if (!this.#core) throw new Error('LivequeryCollection is not initialized with a core instance')
        return this.#core.delete<T>(this.ref, id)
    }

    trigger<T>(action: string, payload?: Record<string, any>) {
        if (!this.#core) throw new Error('LivequeryCollection is not initialized with a core instance')
        return this.#core.trigger<T>({
            action,
            payload,
            ref: this.ref
        }) as Observable<{ data: T, error?: Error }>
    }

    resetError() {
        this.error.next(null)
    }

    watch(check: (a: T, b: T) => boolean) {
        return this.items.pipe(
            switchMap(items => merge(
                ...items.map(item => item.pipe(
                    pairwise(),
                    filter(([p, n]) => {
                        return check(p, n)
                    })
                ))
            ))
        )
    }
} 