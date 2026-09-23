import { createRemoteLivequeryClient } from '@livequery/client'
import { ServiceLinker, SharedWorkerChannel } from '@livequery/rpc'
import { createClient } from './createClient'

export type Host = 'shared-worker' | 'tab'

function connect() {
    if (typeof SharedWorker === 'undefined') {
        // Chrome on Android has no SharedWorker: this tab runs its own client. Tabs still share
        // IndexedDB and meet through the server's realtime, and navigator.locks keeps one outbox
        // drainer — but an offline change reaches other tabs only once it is synced.
        return { client: createClient(window.location.origin), host: 'tab' as Host }
    }
    // extendedLifetime: a reload of the only tab would otherwise leave the worker with no page for a
    // moment, and Chrome would stop it — closing its WebSocket.
    const worker = new SharedWorker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'livequery-todos', extendedLifetime: true } as WorkerOptions)
    const linker = new ServiceLinker(new SharedWorkerChannel(worker))
    return { client: createRemoteLivequeryClient(linker.linkService<any>('livequery')), host: 'shared-worker' as Host }
}

export const { client, host } = connect()
