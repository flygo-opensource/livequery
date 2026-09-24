import { LivequeryCollection, type Doc, type LivequeryCollectionOptions } from "@livequery/client"
import { useMemo, useEffect, useCallback, useRef, useSyncExternalStore } from "react"
import { merge, skip, switchMap } from "rxjs"
import { useLivequeryClient, useLivequeryContext } from "./LivequeryClientContext.js"

// Everything a render reads from a collection: the list, each document in it, and its state.
const changesOf = (collection: LivequeryCollection<any>) => merge(
    collection.items.pipe(switchMap(items => merge(...items.map(item => item.pipe(skip(1)))))),
    collection.items.pipe(skip(1)),
    collection.loading.pipe(skip(1)),
    collection.error.pipe(skip(1)),
    collection.paging.pipe(skip(1)),
    collection.summary.pipe(skip(1)),
    collection.filters.pipe(skip(1)),
    collection.selected.pipe(skip(1)),
    collection.completeness.pipe(skip(1)),
    collection.status.pipe(skip(1)),
)

/**
 * A collection that re-renders the component when anything it shows changes — its items, any
 * document's value, loading, status, error, paging, summary, filters, selection or completeness — so a
 * component reads `collection.items.value`, `collection.loading.value`, … directly.
 */
export const useCollection = <T extends Doc>(ref: string | undefined | '' | null | false, options: Partial<LivequeryCollectionOptions<T>> = {}) => {
    const client = useLivequeryClient()
    // Provider-level context (e.g. { account_id }); a per-call options.context overrides it.
    const providerContext = useLivequeryContext()
    const context = { ...providerContext, ...options.context }
    const contextKey = JSON.stringify(context)
    // Recreate the collection whenever the ref OR the context changes so each (ref, context)
    // pair gets a fresh, fully-reset instance — switching account re-subscribes under the new
    // context. The client is stable (provided once via context), so it is intentionally NOT a
    // dependency — keying on it would rebuild the collection on every render if a caller ever
    // passed an unstable client.
    const collection = useMemo(() => new LivequeryCollection<T>(client, { ...options, context }), [ref, contextKey])
    useEffect(() => {
        if (!client || !ref) return
        const linker = collection.initialize(ref)
        return () => {
            linker?.unsubscribe()
        }
    }, [collection])

    // A version bumped once per burst of changes: one render for a page of documents, not one each.
    const version = useRef(0)
    const subscribe = useCallback((notify: () => void) => {
        let scheduled = false
        const subscription = changesOf(collection).subscribe(() => {
            if (scheduled) return
            scheduled = true
            queueMicrotask(() => {
                scheduled = false
                version.current++
                notify()
            })
        })
        return () => subscription.unsubscribe()
    }, [collection])
    useSyncExternalStore(subscribe, () => version.current, () => version.current)
    return collection
}
