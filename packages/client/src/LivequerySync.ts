import { BehaviorSubject, concatMap, firstValueFrom, from, Subscription, type Observable } from 'rxjs'
import type { LivequeryStorage } from './LivequeryStorage.js'
import type { LivequeryQueryResult, LivequeryTransporter } from './LivequeryTransporter.js'
import type { DataChangeEvent, Doc, DocState, LivequeryCompleteness, LocalFirstConfig, LocalFirstScope } from './types.js'
import { parseDuration } from './helpers/parseDuration.js'

/** Storage ref the sync keeps its scope bookkeeping under. Collections cannot watch it. */
export const LIVEQUERY_SYNC_REF = '__livequery_sync'

const PAGE = 100
const DEFAULT_WINDOW = 200
const DEFAULT_KEEP = 10 * 60_000
const DEFAULT_EVICT = 30 * 86_400_000
const DEFAULT_OVERLAP = 10_000
const CONCURRENT_READS = 4

export type SyncIngestOptions = {
    source: 'query' | 'realtime'
    /** false: write storage only; the caller broadcasts. */
    broadcast?: boolean
}

export type LivequerySyncOptions = {
    storage: LivequeryStorage
    transporters: Record<string, LivequeryTransporter>
    /** The client's single write path: rebase, version check, storage, then collections. */
    ingest: (transporter_id: string, collection_ref: string, changes: DataChangeEvent[], options: SyncIngestOptions) => Promise<DataChangeEvent[]>
    /** A complete re-read, for servers without versions: collections reconcile with it. */
    refetched: (collection_ref: string, changes: DataChangeEvent[]) => Promise<void>
    /** How far back (ms) a delta reaches before `synced_at`. Default 10 000. */
    overlap?: number
}

export type ScopeStatus = {
    /** The first load finished: the device holds the scope's first window. */
    loaded: boolean
    /** Nothing older exists on the server beyond what the device holds. */
    complete: boolean
    /** Loading older documents (`extend`). */
    extending: boolean
    /** A first load, delta or re-read is running. */
    fetching: boolean
    /** Why the last catch-up failed (offline, server error): the device shows what it has. */
    error?: { code: string, message: string }
}

export type SyncHandle = {
    readonly status$: Observable<ScopeStatus>
    release(): void
}

// What is persisted per scope, so a reload resumes where the last session stopped.
type ScopeMeta = {
    id: string
    config: LocalFirstConfig
    context?: Record<string, any>
    loaded: boolean
    complete: boolean
    /** The server's cursor to the page after the oldest document the device holds. */
    next_cursor: string | null
    /** Newest `updated_at` seen: the next delta asks for anything newer. */
    synced_at: number | null
    /** The server sends `updated_at`, so deltas are possible. */
    versioned: boolean
    last_used_at: number
}

type Scope = {
    meta: ScopeMeta
    holders: Map<string, LocalFirstConfig>
    status$: BehaviorSubject<ScopeStatus>
    realtime?: Subscription
    catching_up?: Promise<void>
    stop_timer?: ReturnType<typeof setTimeout>
    children: Map<string, SyncHandle>
    active: boolean
    /**
     * Realtime has been continuous since the last catch-up, so its events may move `synced_at`.
     * Off from the moment realtime (re)opens until a catch-up completes: an event arriving in
     * between is newer than changes the delta has not fetched yet.
     */
    live: boolean
}

const RANK: Record<LocalFirstScope, number> = { 'on-demand': 0, window: 1, full: 2 }

/** The widest of several declarations for one ref. */
export function mergeLocalFirstConfigs(configs: LocalFirstConfig[]): LocalFirstConfig {
    const scope = configs.map(c => c.scope ?? 'full').reduce((a, b) => RANK[b] > RANK[a] ? b : a, 'on-demand' as LocalFirstScope)
    const keep = configs.map(c => parseDuration(c.keep, DEFAULT_KEEP)).reduce((a, b) => Math.max(a, b), 0)
    const evict = configs.map(c => parseDuration(c.evict, DEFAULT_EVICT)).reduce((a, b) => Math.max(a, b), 0)
    const children: Record<string, LocalFirstConfig> = {}
    for (const config of configs) {
        for (const [pattern, child] of Object.entries(config.children ?? {})) {
            children[pattern] = children[pattern] ? mergeLocalFirstConfigs([children[pattern]!, child]) : child
        }
    }
    return {
        scope,
        ...scope === 'window' ? { size: Math.max(...configs.map(c => c.size ?? (c.scope === 'window' ? DEFAULT_WINDOW : 0))) } : {},
        ...configs.find(c => c.sort)?.sort ? { sort: configs.find(c => c.sort)!.sort } : {},
        keep: keep === Infinity ? 'always' : keep,
        evict,
        ...Object.keys(children).length > 0 ? { children } : {},
    }
}

/** Fill `:field` placeholders of a child ref from a document; undefined when a field is missing. */
function childRef(pattern: string, doc: Record<string, any>) {
    let missing = false
    const ref = pattern.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, field: string) => {
        const value = doc[field]
        if (value === undefined || value === null) missing = true
        return encodeURIComponent(String(value))
    })
    return missing ? undefined : ref
}

const sortFilters = (config: LocalFirstConfig, fallback: Record<string, any>) => config.sort
    ? Object.fromEntries(Object.entries(config.sort).map(([field, direction]) => [`${field}:sort`, direction]))
    : Object.fromEntries(Object.entries(fallback).filter(([k]) => k.endsWith(':sort')))

/**
 * Keeps the local copy of local-first collections in sync with the server — as much as each
 * collection declares (`mode: { scope, size, keep, evict, children }`), and no more.
 *
 * - First use of a scope: loads it (everything, the newest `size`, or one page).
 * - Later uses, reconnects and reloads: a delta — only what changed since `synced_at` — when the
 *   server versions documents; otherwise a re-read of what the device holds.
 * - While in use (and for `keep` after): a realtime subscription for the ref.
 * - Scrolling past what the device holds: `extend()` loads the next older page and keeps it.
 * - `children`: every document of a scope declares a scope of its own (e.g. each chat's messages).
 * - `keep: 'always'` scopes are persisted and resumed at start, before any UI asks for them.
 * - Scopes unused for `evict` lose their local copy.
 *
 * Everything it downloads goes through the client's `ingest` — the only way server data reaches
 * storage — so it never races realtime or the outbox.
 */
export class LivequerySync {
    readonly #options: LivequerySyncOptions
    readonly #scopes = new Map<string, Scope>()
    #reads = 0
    readonly #waiting: Array<() => void> = []
    #stopped = false

    constructor(options: LivequerySyncOptions) {
        this.#options = options
    }

    /** Resume the scopes declared `keep: 'always'` by an earlier session, and drop stale ones. */
    async start() {
        const { documents } = await this.#options.storage.query<ScopeMeta>(LIVEQUERY_SYNC_REF)
        const now = Date.now()
        for (const meta of documents) {
            if (now - meta.last_used_at > parseDuration(meta.config.evict, DEFAULT_EVICT)) {
                await this.#evict(meta)
                continue
            }
            if (meta.config.keep !== 'always' || this.#stopped) continue
            this.acquire(meta.id, meta.config, 'persisted', meta.context)
        }
    }

    stop() {
        this.#stopped = true
        for (const scope of this.#scopes.values()) this.#deactivate(scope)
        this.#scopes.clear()
    }

    /** Storage was flushed: forget every scope, keep serving the ones still in use. */
    cleared() {
        for (const scope of this.#scopes.values()) {
            scope.meta = { ...this.#emptyMeta(scope.meta.id, scope.meta.config, scope.meta.context) }
            scope.status$.next({ loaded: false, complete: false, extending: false, fetching: false })
            if (scope.active) scope.catching_up = this.#catchUp(scope).catch(() => undefined)
        }
    }

    /**
     * Declare that `holder` needs `ref` on the device as `config` says. Returns a handle to release it.
     * Declarations for one ref merge: the widest wins.
     */
    acquire(ref: string, config: LocalFirstConfig, holder: string, context?: Record<string, any>): SyncHandle {
        let scope = this.#scopes.get(ref)
        if (!scope) {
            scope = {
                meta: this.#emptyMeta(ref, config, context),
                holders: new Map(),
                status$: new BehaviorSubject<ScopeStatus>({ loaded: false, complete: false, extending: false, fetching: false }),
                children: new Map(),
                active: false,
                live: false,
            }
            this.#scopes.set(ref, scope)
            const created = scope
            // Pick up what an earlier session stored about this ref.
            created.catching_up = this.#options.storage.get<ScopeMeta>(LIVEQUERY_SYNC_REF, ref).then(stored => {
                if (stored) created.meta = { ...stored, config: created.meta.config, context: created.meta.context ?? stored.context }
                created.status$.next({ ...created.status$.value, loaded: created.meta.loaded, complete: created.meta.complete })
            })
        }
        scope.holders.set(holder, config)
        scope.meta.config = mergeLocalFirstConfigs([...scope.holders.values()])
        scope.meta.context ??= context
        if (holder !== 'persisted' && !holder.startsWith('child:')) scope.meta.last_used_at = Date.now()
        this.#activate(scope)
        const target = scope
        let released = false
        return {
            status$: target.status$.asObservable(),
            release: () => {
                if (released) return
                released = true
                this.#release(target, holder)
            },
        }
    }

    /** Whether the device holds everything `ref`'s scope covers. */
    completeness(ref: string): LivequeryCompleteness {
        const meta = this.#scopes.get(ref)?.meta
        if (!meta?.loaded) return 'unknown'
        return meta.complete ? 'complete' : 'partial'
    }

    /**
     * The collection scrolled past what the device holds: load the next older page and keep it.
     * Resolves true when something was loaded; throws when the server cannot be reached.
     */
    async extend(ref: string, limit = PAGE): Promise<boolean> {
        const scope = this.#scopes.get(ref)
        if (!scope) return false
        await scope.catching_up
        if (scope.meta.complete || !scope.meta.next_cursor) return false
        scope.status$.next({ ...scope.status$.value, extending: true })
        try {
            const page = await this.#read(scope, {
                ...sortFilters(scope.meta.config, {}),
                ':limit': Math.max(limit, 1),
                ':after': scope.meta.next_cursor,
            })
            // Older documents: their versions say nothing about what else changed.
            await this.#ingest(scope, page, { source: 'query' }, false)
            scope.meta.next_cursor = page.result.paging?.next?.cursor ?? null
            scope.meta.complete = !scope.meta.next_cursor
            await this.#persist(scope)
            return (page.result.changes?.length ?? 0) > 0
        } finally {
            scope.status$.next({ ...scope.status$.value, loaded: scope.meta.loaded, complete: scope.meta.complete, extending: false })
        }
    }

    /** A transporter reconnected: realtime events were lost, catch every active scope up. */
    reconnected() {
        for (const scope of this.#scopes.values()) {
            if (!scope.active) continue
            this.#closeRealtime(scope)
            this.#openRealtime(scope)
            scope.catching_up = (scope.catching_up ?? Promise.resolve())
                .then(() => this.#catchUp(scope))
                .catch(e => console.warn('livequery sync: catching up failed', scope.meta.id, e?.code ?? e?.message ?? e))
        }
    }

    // ── Internal ───────────────────────────────────────────────────────────────

    #emptyMeta(ref: string, config: LocalFirstConfig, context?: Record<string, any>): ScopeMeta {
        return {
            id: ref,
            config,
            ...context ? { context } : {},
            loaded: false,
            complete: false,
            next_cursor: null,
            synced_at: null,
            versioned: false,
            last_used_at: Date.now(),
        }
    }

    #activate(scope: Scope) {
        scope.stop_timer && clearTimeout(scope.stop_timer)
        scope.stop_timer = undefined
        if (scope.active || this.#stopped) return
        scope.active = true
        this.#openRealtime(scope)
        scope.catching_up = (scope.catching_up ?? Promise.resolve())
            .then(() => this.#catchUp(scope))
            .catch(e => console.warn('livequery sync: catching up failed', scope.meta.id, e?.code ?? e?.message ?? e))
    }

    #release(scope: Scope, holder: string) {
        scope.holders.delete(holder)
        if (scope.holders.size > 0) {
            scope.meta.config = mergeLocalFirstConfigs([...scope.holders.values()])
            return
        }
        const keep = parseDuration(scope.meta.config.keep, DEFAULT_KEEP)
        if (keep === Infinity) return
        scope.stop_timer = setTimeout(() => {
            if (scope.holders.size > 0) return
            this.#deactivate(scope)
        }, keep)
        ;(scope.stop_timer as any)?.unref?.()
    }

    #deactivate(scope: Scope) {
        scope.stop_timer && clearTimeout(scope.stop_timer)
        scope.active = false
        this.#closeRealtime(scope)
        for (const child of scope.children.values()) child.release()
        scope.children.clear()
    }

    async #catchUp(scope: Scope) {
        if (this.#stopped) return
        // Children of what the device already holds, before any network.
        await this.#adoptChildren(scope)
        scope.status$.next({ ...scope.status$.value, fetching: true, error: undefined })
        let error: ScopeStatus['error']
        try {
            if (!scope.meta.loaded) await this.#initialLoad(scope)
            else if (scope.meta.versioned && scope.meta.synced_at !== null) await this.#delta(scope)
            else await this.#refresh(scope)
            scope.live = !!scope.realtime
        } catch (e: any) {
            error = { code: e?.code ?? 'SYNC_FAILED', message: e?.message ?? String(e) }
            throw e
        } finally {
            scope.status$.next({ loaded: scope.meta.loaded, complete: scope.meta.complete, extending: false, fetching: false, ...error ? { error } : {} })
        }
    }

    // First load: everything, the newest `size`, or one page.
    async #initialLoad(scope: Scope) {
        const config = scope.meta.config
        const target = config.scope === 'window' ? (config.size ?? DEFAULT_WINDOW) : config.scope === 'on-demand' ? PAGE : Infinity
        let loaded = 0
        let cursor: string | undefined
        while (loaded < target) {
            const page = await this.#read(scope, {
                ...sortFilters(config, {}),
                ':limit': Math.min(PAGE, target - loaded),
                ...cursor ? { ':after': cursor } : {},
            })
            await this.#ingest(scope, page, { source: 'query' }, true)
            loaded += page.result.changes?.length ?? 0
            cursor = page.result.paging?.next?.cursor
            if (!cursor) break
        }
        scope.meta.loaded = true
        scope.meta.next_cursor = cursor ?? null
        scope.meta.complete = !cursor
        await this.#persist(scope)
    }

    // Only what changed since the last sync, tombstones included.
    async #delta(scope: Scope) {
        // From a little before the newest version held, fixed for every page of this delta. A
        // write can carry a version at or just below it and still be committed after the read
        // that set it — or come from a server whose clock is slightly behind. The overlap is read
        // again; the ingest ignores what is not newer than the copy on the device.
        const since = scope.meta.synced_at! - (this.#options.overlap ?? DEFAULT_OVERLAP)
        let cursor: string | undefined
        do {
            const page = await this.#read(scope, {
                'updated_at:gte': since,
                'updated_at:sort': 'asc',
                ':limit': PAGE,
                ':tombstones': 1,
                ...cursor ? { ':after': cursor } : {},
            })
            await this.#ingest(scope, page, { source: 'query' }, true)
            cursor = page.result.paging?.next?.cursor
        } while (cursor)
        await this.#persist(scope)
    }

    // No versions from the server: re-read what the device covers. A complete `full` scope can
    // then tell which local documents the server no longer has.
    async #refresh(scope: Scope) {
        const config = scope.meta.config
        const changes: DataChangeEvent[] = []
        let cursor: string | undefined
        let pages = 0
        const covered = config.scope === 'full' ? Infinity : Math.ceil((config.size ?? DEFAULT_WINDOW) / PAGE)
        while (pages < covered) {
            const page = await this.#read(scope, {
                ...sortFilters(config, {}),
                ':limit': PAGE,
                ...cursor ? { ':after': cursor } : {},
            })
            changes.push(...await this.#ingest(scope, page, { source: 'query', broadcast: false }, true))
            cursor = page.result.paging?.next?.cursor
            pages++
            if (!cursor) break
        }
        if (config.scope === 'full' && !cursor) {
            const seen = new Set(changes.map(c => c.id))
            const { documents } = await this.#options.storage.query<DocState<Doc>>(scope.meta.id)
            for (const doc of documents) {
                if (seen.has(doc.id) || isUnsynced(doc)) continue
                await this.#options.storage.delete(scope.meta.id, doc.id)
                changes.push({ collection_ref: scope.meta.id, id: doc.id, type: 'removed' })
                scope.children.forEach((handle, key) => key.startsWith(`${doc.id}|`) && handle.release())
            }
        }
        await this.#options.refetched(scope.meta.id, changes)
        await this.#persist(scope)
    }

    #openRealtime(scope: Scope) {
        if (scope.realtime || this.#stopped) return
        scope.live = false
        const subscription = new Subscription()
        for (const [transporter_id, transporter] of Object.entries(this.#options.transporters)) {
            // Realtime only: the first answer is one document, not another copy of the scope.
            const filters = { ...sortFilters(scope.meta.config, {}), ':limit': 1 }
            subscription.add(transporter.query({ ref: scope.meta.id, filters, context: scope.meta.context }).pipe(
                concatMap((result, index) => from((async () => {
                    if (result.error || !result.changes?.length) return
                    // The first answer is one document, not what changed: it never moves `synced_at`.
                    await this.#ingest(scope, { transporter_id, result }, { source: index === 0 ? 'query' : 'realtime' }, index > 0 && scope.live)
                    await this.#persist(scope)
                })()))
            ).subscribe({ error: e => console.warn('livequery sync: realtime failed', scope.meta.id, e) }))
        }
        scope.realtime = subscription
    }

    #closeRealtime(scope: Scope) {
        scope.realtime?.unsubscribe()
        scope.realtime = undefined
    }

    // `advance`: the page covers every change up to its newest version (a load or a delta), so the
    // next delta may start from there.
    async #ingest(scope: Scope, page: { transporter_id: string, result: Partial<LivequeryQueryResult> }, options: SyncIngestOptions, advance: boolean) {
        const changes = page.result.changes ?? []
        if (changes.length === 0) return []
        for (const change of changes) {
            const version = change.data?.updated_at
            if (typeof version !== 'number') continue
            scope.meta.versioned = true
            if (advance) scope.meta.synced_at = Math.max(scope.meta.synced_at ?? 0, version)
        }
        const ingested = await this.#options.ingest(page.transporter_id, scope.meta.id, changes, options)
        await this.#childrenOf(scope, ingested)
        return ingested
    }

    // Every document of a scope with `children` declares one scope per pattern.
    async #childrenOf(scope: Scope, changes: DataChangeEvent[]) {
        const patterns = Object.entries(scope.meta.config.children ?? {})
        if (patterns.length === 0 || !scope.active) return
        for (const change of changes) {
            if (change.type === 'removed') {
                for (const [key, handle] of scope.children) {
                    if (!key.startsWith(`${change.id}|`)) continue
                    handle.release()
                    scope.children.delete(key)
                }
                continue
            }
            const doc = { ...await this.#options.storage.get<Doc>(scope.meta.id, change.id), ...change.data, id: change.data?.id ?? change.id }
            for (const [pattern, config] of patterns) {
                const ref = childRef(pattern, doc)
                const key = `${doc.id}|${pattern}`
                if (!ref || scope.children.has(key)) continue
                scope.children.set(key, this.acquire(ref, config, `child:${scope.meta.id}:${doc.id}`, scope.meta.context))
            }
        }
    }

    async #adoptChildren(scope: Scope) {
        if (!scope.meta.config.children || !scope.active) return
        const { documents } = await this.#options.storage.query<Doc>(scope.meta.id)
        await this.#childrenOf(scope, documents.map(doc => ({ collection_ref: scope.meta.id, id: doc.id, type: 'added', data: doc })))
    }

    // One read through each transporter; the first that answers wins. At most CONCURRENT_READS at once,
    // so a scope with many children does not open dozens of requests together.
    async #read(scope: Scope, filters: Record<string, any>): Promise<{ transporter_id: string, result: Partial<LivequeryQueryResult> }> {
        await this.#slot()
        try {
            let failure: unknown
            for (const [transporter_id, transporter] of Object.entries(this.#options.transporters)) {
                const params = { ref: scope.meta.id, filters, context: scope.meta.context }
                const result = transporter.read
                    ? await transporter.read(params)
                    : await firstValueFrom(transporter.query(params))
                if (result.error) {
                    failure = result.error
                    continue
                }
                return { transporter_id, result }
            }
            throw failure ?? { code: 'NO_TRANSPORTER', message: 'No transporter to sync with' }
        } finally {
            this.#reads--
            this.#waiting.shift()?.()
        }
    }

    #slot() {
        if (this.#reads < CONCURRENT_READS) {
            this.#reads++
            return Promise.resolve()
        }
        return new Promise<void>(resolve => this.#waiting.push(() => {
            this.#reads++
            resolve()
        }))
    }

    async #persist(scope: Scope) {
        const storage = this.#options.storage
        const stored = await storage.update(LIVEQUERY_SYNC_REF, scope.meta.id, scope.meta)
        if (!stored) await storage.add(LIVEQUERY_SYNC_REF, { ...scope.meta } as any)
    }

    // Drop a scope's local copy — except documents with writes still waiting to go out.
    async #evict(meta: ScopeMeta) {
        const storage = this.#options.storage
        const { documents } = await storage.query<DocState<Doc>>(meta.id)
        for (const doc of documents) {
            if (doc._adding || doc._prev || doc._deleting || doc._queued || doc._local_only) continue
            await storage.delete(meta.id, doc.id)
        }
        await storage.delete(LIVEQUERY_SYNC_REF, meta.id)
    }
}

// Exists only on this device so far: a re-read that does not see it must not remove it.
function isUnsynced(doc: Record<string, any>) {
    return String(doc.id).startsWith('local:') || !!doc._adding || !!doc._local_only
}
