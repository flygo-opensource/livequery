import { ServiceLinker, SharedWorkerChannel } from '@livequery/rpc'
import { TodoService } from './TodoService'

/** The methods a tab uses. Remote calls return awaitable observables, so both hosts fit. */
export type TodoApi = Pick<TodoService, 'items' | 'status' | 'add' | 'update' | 'remove' | 'setOffline'>

export type Host = 'shared-worker' | 'tab'

function connect(): { api: TodoApi, host: Host } {
    if (typeof SharedWorker === 'undefined') {
        // Chrome on Android has no SharedWorker: this tab keeps its own client. Tabs still share
        // IndexedDB and meet through the server's realtime, and navigator.locks keeps one outbox
        // drainer — but an offline change reaches other tabs only once it is synced.
        return { api: new TodoService(window.location.origin), host: 'tab' }
    }
    // extendedLifetime: survives the reload of the only tab (see examples/chat-demo/web/src/livequery.ts).
    const worker = new SharedWorker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'livequery-todos', extendedLifetime: true } as WorkerOptions)
    const linker = new ServiceLinker(new SharedWorkerChannel(worker))
    return { api: linker.linkService<any>('todos') as TodoApi, host: 'shared-worker' }
}

export const { api: todos, host } = connect()
