import { defer, type Observable } from 'rxjs'
import type { LivequeryClientLike } from './LivequeryCollection.js'

type Remote = { [K in keyof LivequeryClientLike]: (...args: any[]) => any }

// Any object will do — typically a proxy whose every property is a remote method.
type RemoteLike = Remote | object

/**
 * A client for tabs whose real `LivequeryClient` lives elsewhere — a SharedWorker serving every tab
 * of the app, typically linked with `@livequery/rpc`:
 *
 *     // worker
 *     new WorkerManager(new SharedWorkerChannel()).exposeService('livequery', client)
 *     // tab
 *     const linker = new ServiceLinker(new SharedWorkerChannel(worker))
 *     const client = createRemoteLivequeryClient(linker.linkService('livequery'))
 *
 * `remote` is any object whose methods mirror the client's and return promises, thenables or
 * observables; the result is what `LivequeryCollection` (and so `useCollection`) needs. Streams open
 * on subscribe and close on unsubscribe, so a collection unmounting in a tab releases it in the worker.
 */
export function createRemoteLivequeryClient(remote_like: RemoteLike): LivequeryClientLike {
    const remote = remote_like as Remote
    const call = (method: keyof Remote) => (...args: any[]) => Promise.resolve(remote[method](...args))
    const stream = (method: keyof Remote) => (...args: any[]) => defer(() => remote[method](...args) as Observable<any>)
    return {
        watch: stream('watch'),
        trigger: stream('trigger'),
        query: call('query'),
        add: call('add'),
        update: call('update'),
        delete: call('delete'),
        retry: call('retry'),
        flush: call('flush'),
        seedToStorage: call('seedToStorage'),
    } as LivequeryClientLike
}
