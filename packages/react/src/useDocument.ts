import { type Doc, type LivequeryCollectionOptions } from "@livequery/client"
import { useCollection } from "./useCollection.js"


/**
 * The document at `ref`, re-rendering when it changes: `[document, loading, error, status]`.
 * `status` is `'ready'` once anything answered — the server, the cache or the device — so a
 * missing document (`undefined` while ready) is told apart from one still loading.
 */
export const useDocument = <T extends Doc>(ref: string | undefined | '' | null | false, options: Pick<Partial<LivequeryCollectionOptions<T>>, 'lazy' | 'mode' | 'seed' | 'ssr' | 'context'> = {}) => {
    const collection = useCollection<T>(ref, options)
    return [collection.items.value[0], collection.loading.value, collection.error.value, collection.status.value] as const
}
