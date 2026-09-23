import { BehaviorSubject, combineLatest, lastValueFrom, map, Observable, of, switchMap, auditTime } from 'rxjs'
import { LivequeryClient, LivequeryCollection, LivequeryIndexedDBStorage, type DocState, type LivequeryCollectionOptions } from '@livequery/client'
import { RestTransporter } from '@livequery/rest'

export type Account = { id: string, name: string, color: string, created_at: number }

export type Chat = {
    id: string
    type: 'direct' | 'group'
    title?: string
    member_ids: string[]
    last_message?: { text: string, sender_id: string, created_at: number }
    read_at?: Record<string, number>
    unread?: Record<string, number>
    updated_at: number
    created_at: number
}

export type Message = { id: string, chat_id: string, sender_id: string, text: string, created_at: number }

export type Page<T> = {
    items: DocState<T & { id: string }>[]
    has_more: boolean
    loading: boolean
    error: string | null
}

export type SyncStatus = { connected: boolean, offline: boolean, pending: number }

type Live = {
    collection: LivequeryCollection<any>
    linker: { unsubscribe(): void } | undefined
    refs: number
    timer?: ReturnType<typeof setTimeout>
}

/**
 * Everything that talks to the network and to storage — one LivequeryClient, one WebSocket, one
 * outbox, one IndexedDB — for every tab and every account signed in on this browser. It runs in a
 * SharedWorker (see worker.ts); tabs only render what it streams and call its methods.
 *
 * Collections are opened on demand and shared: two tabs on the same chat use one collection. The
 * last tab to leave closes it 30s later, so switching back and forth does not reload.
 */
export class ChatService {
    readonly #offline$ = new BehaviorSubject(false)
    readonly #origin: string
    readonly #transporter: RestTransporter
    readonly #client: LivequeryClient
    readonly #live = new Map<string, Live>()

    constructor(origin: string) {
        this.#origin = origin
        this.#transporter = new RestTransporter({
            api: `${origin}/livequery`,
            ws: `${origin.replace(/^http/, 'ws')}/livequery/realtime-updates`,
            // "Offline" switch: every HTTP request fails like it would with no network. The socket
            // stays up; DevTools → Offline cuts it too.
            onRequest: () => this.#offline$.value
                ? { response: { data: undefined, error: { code: 'NETWORK_ERROR', message: 'Offline' } } }
                : undefined,
        })
        this.#client = new LivequeryClient({
            storage: new LivequeryIndexedDBStorage({ name: 'livequery-chat-demo', persist: true }),
            transporters: { rest: this.#transporter },
        })
        this.#offline$.subscribe(offline => {
            if (offline) return
            this.#client.outbox.trigger()
            this.#client.refetch()
        })
    }

    // ── Reads ────────────────────────────────────────────────────────────────────────────────

    /** Every account on the server (small: synced whole, readable offline). */
    accounts(): Observable<Account[]> {
        return this.#watch('accounts', 'accounts', { mode: 'local-first' }, collection => values(collection).pipe(
            map(items => [...items].sort((a, b) => a.name.localeCompare(b.name)) as Account[]),
        ))
    }

    /** The chats of one account, most recent first, 20 per page. */
    chats(account_id: string): Observable<Page<Chat>> {
        const ref = `accounts/${account_id}/chats`
        return this.#watch(ref, ref, {
            mode: 'cache-first',
            filters: { ':limit': 20, 'updated_at:sort': 'desc' } as any,
            context: { account_id },
        }, page<Chat>)
    }

    moreChats(account_id: string) {
        return this.#live.get(`accounts/${account_id}/chats`)?.collection.loadMore()
    }

    /** One chat's header: title, members, read receipts. */
    chat(chat_id: string): Observable<Chat | null> {
        const ref = `chats/${chat_id}`
        return this.#watch(ref, ref, { mode: 'cache-first' }, collection => values(collection).pipe(
            map(items => (items[0] as Chat | undefined) ?? null),
        ))
    }

    /** One chat's messages, newest first, 30 per page; `olderMessages` loads the next page. */
    messages(chat_id: string): Observable<Page<Message>> {
        const ref = `chats/${chat_id}/messages`
        return this.#watch(ref, ref, {
            mode: 'cache-first',
            filters: { ':limit': 30, 'created_at:sort': 'desc' } as any,
        }, page<Message>)
    }

    olderMessages(chat_id: string) {
        return this.#live.get(`chats/${chat_id}/messages`)?.collection.loadMore()
    }

    status(): Observable<SyncStatus> {
        return combineLatest([
            this.#transporter.status$ ?? of({ connected: true }),
            this.#offline$,
            this.#client.outbox.pending$,
        ]).pipe(map(([status, offline, pending]) => ({ connected: status.connected, offline, pending: pending.length })))
    }

    // ── Writes ───────────────────────────────────────────────────────────────────────────────

    /** Join by name: creates the account on the server, or signs into the one with that name. */
    async join(name: string): Promise<Account> {
        return await this.#post<Account>('accounts', { name })
    }

    /** Opens a chat on the server: two people without a title is a direct chat (reused if it exists). */
    async createChat(member_ids: string[], title?: string): Promise<Chat> {
        return await this.#post<Chat>('chats', { member_ids, ...title ? { title } : {} })
    }

    /**
     * Sends through the outbox: the message shows at once with its final id, waits there while
     * offline, and a retry after a lost answer cannot duplicate it.
     */
    async send(chat_id: string, sender_id: string, text: string) {
        // chat_id is in the URL; the server adds it to the stored message.
        await this.#client.add<Message>(`chats/${chat_id}/messages`, [{ sender_id, text, created_at: Date.now() }], 'local-first')
    }

    /** Sends again a message the server refused. */
    async retry(chat_id: string, message_id: string) {
        await this.#client.retry(`chats/${chat_id}/messages`, [message_id])
    }

    /** Drops a message that never reached the server. */
    async discard(chat_id: string, message_id: string) {
        await this.#client.delete(`chats/${chat_id}/messages`, [message_id], 'local-first')
    }

    /** Read receipt; skipped while offline (the next open sends it). */
    async markRead(chat_id: string, account_id: string) {
        if (this.#offline$.value) return
        await lastValueFrom(this.#client.trigger({ ref: `chats/${chat_id}`, action: 'read', payload: { account_id } }), { defaultValue: null })
            .catch(() => undefined)
    }

    setOffline(offline: boolean) {
        this.#offline$.next(offline)
    }

    // ── Internal ─────────────────────────────────────────────────────────────────────────────

    async #post<T>(path: string, body: unknown): Promise<T> {
        if (this.#offline$.value) throw { code: 'NETWORK_ERROR', message: 'Cần có mạng để làm việc này' }
        const response = await fetch(`${this.#origin}/livequery/${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        })
        const json = await response.json().catch(() => ({})) as any
        if (!response.ok) throw json?.error ?? { code: `HTTP_${response.status}`, message: response.statusText }
        return json.data as T
    }

    // A shared, refcounted collection per key, closed 30s after its last watcher leaves.
    #watch<R>(key: string, ref: string, options: Partial<LivequeryCollectionOptions<any>>, project: (collection: LivequeryCollection<any>) => Observable<R>): Observable<R> {
        return new Observable<R>(subscriber => {
            let live = this.#live.get(key)
            if (!live) {
                const collection = new LivequeryCollection<any>(this.#client, { ssr: false, ...options })
                live = { collection, linker: collection.initialize(ref), refs: 0 }
                this.#live.set(key, live)
            }
            live.timer && clearTimeout(live.timer)
            live.refs++
            const subscription = project(live.collection).subscribe(subscriber)
            const entry = live
            return () => {
                subscription.unsubscribe()
                entry.refs--
                if (entry.refs > 0) return
                entry.timer = setTimeout(() => {
                    entry.linker?.unsubscribe()
                    this.#live.delete(key)
                }, 30_000)
            }
        })
    }
}

// The values of a collection's documents; follows each document, since a `modified` updates one in place.
function values(collection: LivequeryCollection<any>): Observable<any[]> {
    return collection.items.pipe(
        switchMap(items => items.length > 0 ? combineLatest(items) : of([])),
        auditTime(16),
        map(items => items.map(item => ({ ...item }))),
    )
}

function page<T>(collection: LivequeryCollection<any>): Observable<Page<T>> {
    return combineLatest([values(collection), collection.loading, collection.paging, collection.error]).pipe(
        map(([items, loading, paging, error]) => ({
            items,
            has_more: !!paging.next,
            loading: loading !== null,
            error: error ? `${error.code}: ${error.message}` : null,
        })),
    )
}
