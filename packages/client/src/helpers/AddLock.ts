import { Observable, of, Subject, take } from 'rxjs'

type Entry = {
    count: number
    released$: Subject<void>
}

/**
 * Refcounted per-collection lock held while a local add is being reconciled with the server.
 * Realtime `added` events for the collection are held back until every add in flight is done,
 * so the server echo of our own insert lands after the local id has been swapped for the real one.
 */
export class AddLock {
    #entries = new Map<string, Entry>()

    acquire(collection_ref: string): Disposable {
        const entry = this.#entries.get(collection_ref) ?? { count: 0, released$: new Subject<void>() }
        entry.count++
        this.#entries.set(collection_ref, entry)
        let disposed = false
        return {
            [Symbol.dispose]: () => {
                if (disposed) return
                disposed = true
                entry.count--
                if (entry.count > 0) return
                this.#entries.delete(collection_ref)
                entry.released$.next()
                entry.released$.complete()
            },
        }
    }

    locked(collection_ref: string) {
        return this.#entries.has(collection_ref)
    }

    /** Emits once, then completes, when no add is in flight for the collection. */
    pending(collection_ref: string): Observable<void> {
        const entry = this.#entries.get(collection_ref)
        if (!entry) return of(undefined)
        return entry.released$.pipe(take(1))
    }
}
