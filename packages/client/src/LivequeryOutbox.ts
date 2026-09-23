import { BehaviorSubject, type Observable } from 'rxjs'
import { uuidv7 } from 'uuidv7'
import type { LivequeryStorage } from './LivequeryStorage.js'
import type { DocError } from './types.js'

/** Storage ref the outbox persists its entries under. Collections cannot watch it. */
export const LIVEQUERY_OUTBOX_REF = '__livequery_outbox'

export type OutboxOperation = 'add' | 'update' | 'delete'

/**
 * A write waiting to reach one transporter. It carries no payload: what to send is read from
 * storage when the entry is sent (the whole document for `add`, the `_prev` fields for `update`),
 * so a queued entry always sends the latest local state.
 */
export type OutboxEntry = {
    /** uuidv7, so sorting by id is FIFO order. */
    id: string
    transporter_id: string
    collection_ref: string
    op: OutboxOperation
    doc_id: string
    context?: Record<string, any>
    attempts: number
    last_error?: DocError
}

/** How an enqueued write ended, as seen by the mutation that enqueued it. */
export type OutboxSettlement =
    | { status: 'done', data?: any }
    | { status: 'queued' }
    | { status: 'failed', error: DocError }

/** What sending one entry did. `retry` keeps the entry and stalls the queue. */
export type OutboxExecution =
    | { status: 'done', data?: any }
    | { status: 'retry', error: DocError }
    | { status: 'failed', error: DocError }

export type LivequeryOutboxOptions = {
    storage: LivequeryStorage
    /** Send one entry and apply its outcome locally. */
    execute: (entry: OutboxEntry) => Promise<OutboxExecution>
    /** Called once per entry when it becomes stuck behind a retryable failure. */
    onQueued: (entries: OutboxEntry[]) => Promise<void>
    /** `navigator.locks` name shared by every context that sees the same storage. */
    lock?: string
    retryMinMs?: number
    retryMaxMs?: number
}

type Input = Pick<OutboxEntry, 'transporter_id' | 'collection_ref' | 'op' | 'doc_id' | 'context'>

type Waiter = (settlement: OutboxSettlement) => void

/**
 * Durable, strictly FIFO queue of writes. One entry is in flight at a time; a retryable failure
 * stalls the whole queue (order matters: an update must not overtake the add that creates its
 * document) and retries with exponential backoff.
 *
 * Draining starts on `start()` — which resumes whatever a previous session left behind — after each
 * enqueue, on the global `online` event and whenever `trigger()` is called.
 */
export class LivequeryOutbox {
    readonly #pending$ = new BehaviorSubject<OutboxEntry[]>([])
    /**
     * Writes not yet confirmed, oldest first — for a sync indicator ("3 changes waiting"). Emits on
     * every enqueue, confirmation, retry and flush.
     */
    readonly pending$: Observable<OutboxEntry[]> = this.#pending$.asObservable()

    readonly #options: LivequeryOutboxOptions
    readonly #waiters = new Map<string, Waiter[]>()
    readonly #reported = new Set<string>()
    readonly #online = () => this.trigger()

    #inflight: OutboxEntry | null = null
    #running: Promise<void> | null = null
    #again = false
    #stalled = false
    #started = false
    #stopped = false
    #timer: ReturnType<typeof setTimeout> | undefined
    #serial: Promise<unknown> = Promise.resolve()
    #publishing: Promise<void> = Promise.resolve()

    constructor(options: LivequeryOutboxOptions) {
        this.#options = options
    }

    /** Begin draining, including entries persisted by an earlier session. Idempotent. */
    start() {
        if (this.#started || this.#stopped) return
        this.#started = true
        // Feature-detected on globalThis, not window: the client also runs in workers.
        globalThis.addEventListener?.('online', this.#online)
        this.#publish()
        this.trigger()
    }

    /** Stop draining. Mutations still waiting resolve as queued. Idempotent. */
    stop() {
        if (this.#stopped) return
        this.#stopped = true
        this.#clearTimer()
        globalThis.removeEventListener?.('online', this.#online)
        this.#settleAll({ status: 'queued' })
    }

    /** Try to send now, skipping any backoff in progress. */
    trigger() {
        if (!this.#started || this.#stopped) return
        this.#clearTimer()
        if (this.#running) {
            this.#again = true
            return
        }
        this.#running = this.#drain()
            .catch(e => console.error('livequery outbox: drain failed', e))
            .finally(() => {
                this.#running = null
                if (!this.#again) return
                this.#again = false
                this.trigger()
            })
    }

    /** Entries not yet confirmed, oldest first. */
    async pending(): Promise<OutboxEntry[]> {
        const { documents } = await this.#options.storage.query<OutboxEntry>(LIVEQUERY_OUTBOX_REF)
        return documents.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    }

    /**
     * Queue a write and resolve when it is confirmed, fails for good, or gets stuck behind a
     * retryable failure (`queued`). Writes to a document that already has an unsent entry are
     * folded into it.
     */
    async enqueue(input: Input): Promise<OutboxSettlement> {
        // The waiter is registered inside the serialized step, before a confirmation can run.
        const decision = await this.#serialize(async () => {
            const result = await this.#coalesce(input)
            const settlement = result.settled
                ? Promise.resolve(result.settled)
                : new Promise<OutboxSettlement>(resolve => this.#wait(result.entry_id, resolve))
            return { ...result, settlement }
        })
        this.#publish()
        if (decision.settled) return decision.settled
        if (this.#stalled) {
            decision.created && await this.#report([decision.created])
            this.#settle(decision.entry_id, { status: 'queued' })
        }
        this.trigger()
        return await decision.settlement
    }

    /** Point entries at a document's new id, after its `add` was confirmed under a server id. */
    async remap(collection_ref: string, from_id: string, to_id: string) {
        if (from_id === to_id) return
        await this.#serialize(async () => {
            for (const entry of await this.pending()) {
                if (entry.collection_ref !== collection_ref || entry.doc_id !== from_id) continue
                await this.#options.storage.update(LIVEQUERY_OUTBOX_REF, entry.id, { doc_id: to_id })
            }
        })
        this.#publish()
    }

    /** The storage was flushed: every entry is gone, release whoever waits on one. */
    cleared() {
        this.#reported.clear()
        this.#stalled = false
        this.#pending$.next([])
        this.#settleAll({
            status: 'failed',
            error: { code: 'OUTBOX_CLEARED', message: 'The outbox was flushed before this write was sent', transporter_id: '' },
        })
    }

    // ── Internal ───────────────────────────────────────────────────────────────

    async #coalesce(input: Input): Promise<{ settled?: OutboxSettlement, entry_id: string, created?: OutboxEntry }> {
        const storage = this.#options.storage
        const inflight = this.#inflight
        const matches = (e: OutboxEntry) => e.transporter_id === input.transporter_id
            && e.collection_ref === input.collection_ref
            && e.doc_id === input.doc_id
        const same = (await this.pending()).filter(e => matches(e) && e.id !== inflight?.id)
        const adding_now = inflight?.op === 'add' && matches(inflight)
        const is_local = input.doc_id.startsWith('local:')
        const done = { settled: { status: 'done' } as OutboxSettlement, entry_id: '' }

        if (input.op === 'update') {
            // An unsent add or update reads the latest document when it goes out — it already
            // carries this edit.
            const target = same.find(e => e.op === 'add' || e.op === 'update')
            if (target) return { entry_id: target.id }
            // Never created on the server and not being created: nothing to update there.
            if (is_local && !adding_now) return done
        }

        if (input.op === 'delete') {
            const add = same.find(e => e.op === 'add')
            for (const entry of same) {
                await storage.delete(LIVEQUERY_OUTBOX_REF, entry.id)
                this.#reported.delete(entry.id)
                this.#settle(entry.id, { status: 'done' })
            }
            // The server never heard of it: dropping the add is the whole delete.
            if (add || (is_local && !adding_now)) return done
        }

        const entry: OutboxEntry = { ...input, id: uuidv7(), attempts: 0 }
        await storage.add(LIVEQUERY_OUTBOX_REF, entry)
        return { entry_id: entry.id, created: entry }
    }

    async #drain() {
        const locks = this.#options.lock ? globalThis.navigator?.locks : undefined
        if (!locks) return await this.#loop()
        await locks.request(this.#options.lock!, { ifAvailable: true }, async lock => {
            if (lock) return await this.#loop()
            // Another tab holds the queue and will send these entries too; look again later.
            await this.#report(await this.pending())
            this.#settleAll({ status: 'queued' })
            this.#schedule(1)
        })
    }

    async #loop() {
        while (!this.#stopped) {
            const entries = await this.pending()
            const head = entries[0]
            if (!head) {
                this.#stalled = false
                return
            }

            this.#inflight = head
            const result = await this.#options.execute(head).catch((e): OutboxExecution => ({
                status: 'failed',
                error: { code: e?.code ?? 'OUTBOX_EXECUTE_FAILED', message: e?.message ?? String(e), transporter_id: head.transporter_id },
            }))
            this.#inflight = null

            if (result.status === 'retry') {
                const attempts = head.attempts + 1
                await this.#options.storage.update(LIVEQUERY_OUTBOX_REF, head.id, { attempts, last_error: result.error })
                this.#publish()
                this.#stalled = true
                await this.#report(entries)
                this.#settleAll({ status: 'queued' })
                this.#schedule(attempts)
                return
            }

            await this.#serialize(async () => {
                await this.#options.storage.delete(LIVEQUERY_OUTBOX_REF, head.id)
                this.#reported.delete(head.id)
                this.#stalled = false
                this.#settle(head.id, result)
            })
            this.#publish()
        }
    }

    // Reads are chained so an older read can never land after a newer one.
    #publish() {
        this.#publishing = this.#publishing
            .then(() => this.pending())
            .then(entries => this.#pending$.next(entries))
            .catch(e => console.error('livequery outbox: reading pending entries failed', e))
    }

    async #report(entries: OutboxEntry[]) {
        const fresh = entries.filter(e => !this.#reported.has(e.id))
        if (fresh.length === 0) return
        for (const entry of fresh) this.#reported.add(entry.id)
        await this.#options.onQueued(fresh).catch(e => console.error('livequery outbox: onQueued failed', e))
    }

    #schedule(attempts: number) {
        if (this.#stopped) return
        this.#clearTimer()
        const min = this.#options.retryMinMs ?? 2000
        const max = this.#options.retryMaxMs ?? 30000
        const delay = Math.min(min * 2 ** Math.max(0, attempts - 1), max)
        this.#timer = setTimeout(() => this.trigger(), delay)
        // Node/Bun: a pending retry must not keep the process alive.
        ;(this.#timer as any)?.unref?.()
    }

    #clearTimer() {
        this.#timer && clearTimeout(this.#timer)
        this.#timer = undefined
    }

    #wait(entry_id: string, waiter: Waiter) {
        const list = this.#waiters.get(entry_id) ?? []
        list.push(waiter)
        this.#waiters.set(entry_id, list)
    }

    #settle(entry_id: string, settlement: OutboxSettlement) {
        const list = this.#waiters.get(entry_id)
        if (!list) return
        this.#waiters.delete(entry_id)
        for (const waiter of list) waiter(settlement)
    }

    #settleAll(settlement: OutboxSettlement) {
        for (const entry_id of [...this.#waiters.keys()]) this.#settle(entry_id, settlement)
    }

    // Coalescing reads the queue then writes it; confirming deletes from it. Running those one at
    // a time keeps an enqueue from folding into an entry that is being confirmed under it.
    #serialize<R>(fn: () => Promise<R>): Promise<R> {
        const run = this.#serial.then(fn, fn)
        this.#serial = run.catch(() => undefined)
        return run
    }
}
