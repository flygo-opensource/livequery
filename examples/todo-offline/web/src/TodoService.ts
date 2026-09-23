import { auditTime, BehaviorSubject, combineLatest, map, of, switchMap, type Observable } from 'rxjs'
import { LivequeryClient, LivequeryCollection, LivequeryIndexedDBStorage, type DocState } from '@livequery/client'
import { RestTransporter } from '@livequery/rest'

export type Todo = {
    id: string
    title: string
    done: boolean
    created_at: number
}

export type TodoState = DocState<Todo>

export type SyncStatus = {
    connected: boolean
    offline: boolean
    pending: number
}

/**
 * Everything that talks to the network and to storage: one LivequeryClient, one collection, one
 * WebSocket, one outbox. It runs inside a SharedWorker, so every tab of the site shares it — a
 * change made in one tab is in the others at once, online or not. Where SharedWorker does not
 * exist (Chrome on Android) the page runs it itself.
 *
 * Only plain data crosses to the tabs: the document subjects stay here, `items()` streams their
 * values.
 */
export class TodoService {
    readonly #offline$ = new BehaviorSubject(false)
    readonly #transporter: RestTransporter
    readonly #client: LivequeryClient
    readonly #todos: LivequeryCollection<Todo>

    constructor(origin: string) {
        this.#transporter = new RestTransporter({
            api: `${origin}/livequery`,
            ws: `${origin.replace(/^http/, 'ws')}/livequery/realtime-updates`,
            // "Simulate offline": every HTTP request fails with NETWORK_ERROR, exactly what the
            // outbox sees without a network. The socket stays up, so other devices' changes
            // still arrive; DevTools → Offline cuts both.
            onRequest: () => this.#offline$.value
                ? { response: { data: undefined, error: { code: 'NETWORK_ERROR', message: 'Simulated offline' } } }
                : undefined,
        })
        this.#client = new LivequeryClient({
            storage: new LivequeryIndexedDBStorage({ name: 'livequery-todo-demo', persist: true }),
            transporters: { rest: this.#transporter },
        })
        // ssr: false — a worker has no `window`, and this is not server rendering.
        this.#todos = new LivequeryCollection<Todo>(this.#client, { ssr: false, mode: 'local-first' })
        this.#todos.initialize('todos')
        this.#offline$.subscribe(offline => {
            if (!offline) this.#client.outbox.trigger()
        })
    }

    items(): Observable<TodoState[]> {
        return this.#todos.items.pipe(
            // A `modified` updates one document subject in place, so follow every document.
            switchMap(items => items.length > 0 ? combineLatest(items) : of([])),
            auditTime(16),
            map(values => values.map(value => ({ ...value }))),
        )
    }

    status(): Observable<SyncStatus> {
        return combineLatest([
            this.#transporter.status$ ?? of({ connected: true }),
            this.#offline$,
            this.#client.outbox.pending$,
        ]).pipe(
            map(([status, offline, pending]) => ({ connected: status.connected, offline, pending: pending.length })),
        )
    }

    async add(title: string) {
        await this.#todos.add({ title, done: false, created_at: Date.now() })
    }

    async update(id: string, patch: Partial<Pick<Todo, 'title' | 'done'>>) {
        await this.#todos.update({ id, ...patch })
    }

    async remove(id: string) {
        await this.#todos.delete(id)
    }

    setOffline(offline: boolean) {
        this.#offline$.next(offline)
    }
}
