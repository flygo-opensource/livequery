import { BehaviorSubject, debounceTime, EMPTY, filter, finalize, lastValueFrom, merge, Observable, pairwise, Subject, Subscription, switchMap, tap } from "rxjs"
import { LivequeryClient, type ActionMode, type CollectionMetadata, type LivequeryLoadingState } from "./LivequeryClient.js"
import type { DataChangeEvent, Doc, DocState, LivequeryFilters, LivequeryPaging, ParitalDocState } from "./types.js"
import { LivequeryDocument } from "./LivequeryDocument.js"
import { uuidv7 } from 'uuidv7'


export type LivequeryCollectionOptions<T extends Doc> = {
    filters: Partial<LivequeryFilters<T>>
    lazy: boolean
    debounce: number
    mode: CollectionMetadata['mode']
    seed: {
        data: T[]
        persist: boolean
    }
}


export type OneOrMany<T> = T | T[]

export class LivequeryCollection<T extends Doc> {

    public readonly id = uuidv7()
    #keys = new Map<keyof T, number>()
    #indexes: Map<string, number>
    #filters = new Subject<Partial<LivequeryFilters<T>>>()

    public ref: string | undefined
    public collection_ref: string | undefined

    public readonly items: BehaviorSubject<LivequeryDocument<DocState<T>>[]>
    public readonly summary: BehaviorSubject<Record<string, any>>
    public readonly loading: BehaviorSubject<LivequeryLoadingState | null>
    public readonly filters: BehaviorSubject<Partial<LivequeryFilters<T>>>
    public readonly paging: BehaviorSubject<LivequeryPaging>
    public readonly selected: BehaviorSubject<Set<string>>
    public readonly error: BehaviorSubject<{ code: string, message: string } | null>
    #index = 0

    constructor(private client: LivequeryClient, private options: Partial<LivequeryCollectionOptions<T>> = {}) {
        const seedDocs = (options.seed?.data ?? []).map((doc, i) =>
            new LivequeryDocument(this, { ...doc, _index: i + 1 } as DocState<T>)
        )
        this.#index = seedDocs.length
        this.#indexes = seedDocs.reduce((map, doc, i) => map.set(doc.value.id, i), new Map<string, number>())
        this.items = new BehaviorSubject<LivequeryDocument<DocState<T>>[]>(seedDocs)
        this.summary = new BehaviorSubject({})
        this.loading = new BehaviorSubject<LivequeryLoadingState>(null)
        this.filters = new BehaviorSubject<Partial<LivequeryFilters<T>>>(options?.filters || {})
        this.paging = new BehaviorSubject<LivequeryPaging>({
            total: 0,
            current: 0
        })
        this.selected = new BehaviorSubject<Set<string>>(new Set())
        this.error = new BehaviorSubject<{ code: string, message: string } | null>(null)
    }

    #commit(items: LivequeryDocument<T>[]) {
        this.items.next(items)
        this.#indexes = items.reduce((p, c, index) => {
            p.set(c.value.id, index)
            return p
        }, new Map<string, number>())
    }


    #defaultMode(): ActionMode {
        return !this.options.mode || this.options.mode === 'cache-first' ? 'server-first' : this.options.mode
    }

    #subscription: Subscription | null = null
    #timer: ReturnType<typeof setTimeout> | undefined
    initialize(ref: string) {
        if (!ref) return
        if (typeof window == 'undefined') return
        // Fix #1: clear pending timer from previous initialize before starting new one
        this.#timer && clearTimeout(this.#timer)
        this.#timer = undefined
        if (this.#subscription) {
            this.#index = 0
            this.#commit([])
            this.loading.next(null)
            this.summary.next({})
            this.paging.next({ total: 0, current: 0 })
            this.error.next(null)
        }
        this.ref = ref
        const refs = ref.split('/')
        this.collection_ref = refs.length % 2 == 0 ? refs.slice(0, -1).join('/') : ref
        const startQuery = () => { !ref.includes('undefined') && this.query(this.filters.value || {}) }
        if (this.options.seed?.persist && this.collection_ref) {
            const persist = this.client.seedToStorage(this.collection_ref, this.options.seed.data)
            if (this.options.lazy !== true) persist.then(startQuery)
        } else if (this.options.lazy !== true) {
            this.#timer = setTimeout(startQuery)
        }
        this.#subscription?.unsubscribe()
        this.#subscription = merge(
            this.options.debounce ? merge(
                this.#filters.pipe(
                    debounceTime(this.options.debounce),
                    switchMap(filters => this.query(filters))
                )
            ) : EMPTY,

            this.client.watch(this.ref, this.id, this.options.mode || 'server-first').pipe(
                finalize(() => {
                    this.#timer && clearTimeout(this.#timer)
                    this.#timer = undefined
                }),
                tap(event => {
                    event.loading !== undefined && event.loading !== this.loading.value && this.loading.next(event.loading)
                    event.summary && this.summary.next(event.summary)
                    event.paging && this.paging.next(event.paging)
                    event.error && this.error.next(event.error)

                    const first = event.changes?.[0]
                    if (first && first.type == 'removed' && first.id == '*') {
                        this.#index = 0
                        this.#commit([])
                        this.loading.next(null)
                        this.summary.next({})
                        this.paging.next({
                            total: 0,
                            current: 0
                        })
                        this.error.next(null)
                        return
                    }

                    if (!event.changes || event.changes.length == 0) return
                    const chaos = event.changes && event.changes.some(change => {
                        if (change.type == 'added' || change.type == 'removed') return true
                        if (change.data && change.data.id && change.data.id != change.id) return true
                        return Object.keys(change.data || {}).some(k => this.#keys.has(k as keyof T))
                    })
                    const sorter = (a: BehaviorSubject<T>, b: BehaviorSubject<T>) => {
                        for (const [key, order] of this.#keys) {
                            const va = a.value[key]
                            const vb = b.value[key]
                            if (typeof va === 'number' && typeof vb === 'number') {
                                if (va < vb) return -order
                                if (va > vb) return order
                                return 0
                            }
                            if (typeof va === 'string' && typeof vb === 'string') {
                                return va.localeCompare(vb) * order
                            }
                            return 0
                        }
                        return a.value.id.localeCompare(b.value.id)
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
                                        const doc = new LivequeryDocument(this, {
                                            id: c.id,
                                            ...c.data,
                                            _index: ++this.#index
                                        } as any as DocState<T>)
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
                    const items = chaos ? [...unsort_items].sort(sorter) : unsort_items
                    chaos && this.#commit(items)
                    event.paging && this.paging.next(event.paging)
                }),
            )
        ).subscribe()
        return this.#subscription
    }


    async #query(raw_filters: Partial<LivequeryFilters<T>>, flush: boolean) {
        if (!this.ref) return
        this.error.next(null)
        const filters = Object.entries(raw_filters).reduce((p, [k, v]) => {
            if (v === undefined) return p
            return {
                ...p,
                [k]: v
            }
        }, {} as Partial<LivequeryFilters<T>>)
        flush && this.#commit([])
        this.#keys = Object.entries(filters).reduce((p, [k, v]) => {
            if (k.endsWith(':sort')) {
                const field = k.split(':')[0] as keyof T
                p.set(field, (v === 'asc' || v == '1') ? 1 : -1)
            }
            return p
        }, new Map<keyof T, number>())
        this.filters.next(filters)
        const cache = await this.client.query<T>({
            ref: this.ref,
            filters,
            collection_id: this.id
        })
        if (cache && cache.documents && flush) {
            this.#commit(cache.documents.map(i => new LivequeryDocument(this, i)))
        }
    }

    async query(filters: Partial<LivequeryFilters<T>>) {
        try {
            await this.#query(filters, true)
        } catch (e) {
            this.loading.next(null)
            this.error.next({
                code: (e as any)?.code ?? 'QUERY_ERROR',
                message: (e as any)?.message ?? String(e)
            })
        }
    }

    async sort(field: keyof T | 'reset', order: 1 | -1 | 'asc' | 'desc') {
        const filters_without_sort = Object.entries(this.filters.value || {}).reduce((p, [k, v]) => {
            if (k.endsWith(':sort')) return p
            return { ...p, [k]: v }
        }, {} as Partial<LivequeryFilters<T>>)

        if (field == 'reset') {
            const items = [...this.items.value].sort((a, b) => Number(a.value._index) - Number(b.value._index))
            this.#commit(items)
            this.filters.next(filters_without_sort as any)
            return
        }



        const i = (order === 'asc' || order === 1) ? 1 : -1
        const filters = {
            ...filters_without_sort,
            [`${field as string}:sort`]: order
        }
        if (this.options.mode != 'local-only') return await this.query(filters as any)
        const sorter = (a: BehaviorSubject<T>, b: BehaviorSubject<T>) => {
            const va = a.value[field]
            const vb = b.value[field]
            if (typeof va === 'number' && typeof vb === 'number') {
                if (va < vb) return -i
                if (va > vb) return i
                return 0
            }
            if (typeof va === 'string' && typeof vb === 'string') {
                return va.localeCompare(vb) * i
            }
            return 0
        }
        const items = [...this.items.value].sort(sorter)
        this.#commit(items)
        this.filters.next(filters as any)
    }

    select(mode: 'all' | 'none' | 'toggle' | true | false, id?: string) {

        if (mode == 'all') {
            const set = new Set(this.items.value.map(i => i.value.id))
            this.selected.next(set)
            this.items.value.forEach(i => this.update({ id: i.value.id, _selected: true } as any, 'local-only'))
            return
        }

        if (mode == 'none') {
            this.selected.next(new Set())
            this.items.value.forEach(i => this.update({ id: i.value.id, _selected: false } as any, 'local-only'))
            return
        }

        if (mode == 'toggle' && !id) {
            const revert_selected = new Set<string>()
            this.items.value.forEach(i => {
                const _selected = !this.selected.value.has(i.value.id)
                _selected && revert_selected.add(i.value.id)
                this.update({ id: i.value.id, _selected } as any, 'local-only')
            })
            this.selected.next(new Set([...revert_selected]))
            return
        }

        if (!id) return

        const index = this.#indexes.get(id)
        if (index == undefined) return
        const item = this.items.value[index]
        if (!item) return
        const current = item.value._selected || false
        const _selected = mode == 'toggle' ? !current : mode
        const set = this.selected.value
        _selected ? set.add(id) : set.delete(id)
        this.selected.next(new Set(set))
        this.update({ id, _selected } as any, 'local-only')
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
        await this.#query(filters || {}, false)
    }


    async loadPrev() {
        const prev = this.paging.value.prev
        if (!prev) return
        const filters = {
            ...this.filters.value,
            ':before': prev.cursor
        }
        await this.#query(filters || {}, false)
    }

    async loadAround(cursor: string) {
        const filters = {
            ...this.filters.value,
            ':after': cursor,
            ':before': cursor
        }
        await this.#query(filters || {}, false)
    }

    async add<Input extends Partial<DocState<T>>[] | Partial<DocState<T>>>(payload: Input, mode: ActionMode = this.#defaultMode()): Promise<Input extends Array<infer U> ? DocState<T>[] : DocState<T>> {
        if (!this.collection_ref) return null as any
        const list = (Array.isArray(payload) ? payload : [payload]) as ParitalDocState<T>[]
        const responses = await this.client.add<T>(this.collection_ref, list, mode)
        return (Array.isArray(payload) ? responses : responses[0]) as any
    }

    async update<Input extends ParitalDocState<T>[] | ParitalDocState<T>>(payload: Input, mode: ActionMode = this.#defaultMode()): Promise<Input extends Array<infer U> ? DocState<T>[] : DocState<T>> {
        if (!this.collection_ref) return null as any
        const list = (Array.isArray(payload) ? payload : [payload]) as ParitalDocState<T>[]
        const responses = await this.client.update<T>(this.collection_ref, list, mode)
        return (Array.isArray(payload) ? responses : responses[0]) as any
    }

    async delete<Input extends (string | string[])>(id: Input, mode: ActionMode = this.#defaultMode()): Promise<Input extends Array<infer U> ? DocState<T>[] : DocState<T>> {
        if (!this.collection_ref) return null as any
        const ids: string[] = Array.isArray(id) ? id : [id]
        const responses = await this.client.delete<T>(this.collection_ref, ids, mode)
        return (Array.isArray(id) ? responses : responses[0]) as any
    }

    trigger<T>(action: string, payload?: Record<string, any>, transporter_id?: string) {
        if (!this.ref) {
            return null as any as T
        }
        const $ = this.client.trigger<T>({
            action,
            payload,
            ref: this.ref,
            transporter_id
        })
        return Object.assign($, {
            then: async (onFulfilled: (value: T) => void, onRejected?: (reason: { code: string, message: string }) => void) => {
                try {
                    const r = await lastValueFrom($)
                    onFulfilled?.(r)
                } catch (e) {
                    onRejected && onRejected(e as any)
                }
            }
        })
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

    async flush() {
        if (!this.collection_ref) return
        return await this.client.flush(this.collection_ref)
    }
}
