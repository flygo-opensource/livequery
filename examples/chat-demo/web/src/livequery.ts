import { createRemoteLivequeryClient } from '@livequery/client'
import { ServiceLinker, SharedWorkerChannel } from '@livequery/rpc'
import { createClient } from './createClient'

export type Host = 'shared-worker' | 'tab'

function connect() {
    if (typeof SharedWorker === 'undefined') {
        // Chrome on Android: no SharedWorker, so this tab runs its own client.
        return { client: createClient(window.location.origin), host: 'tab' as Host }
    }
    // extendedLifetime: a reload of the only tab would otherwise leave the worker with no page for
    // a moment, and Chrome stops it — its WebSocket closes (1006) and every scope catches up again.
    const worker = new SharedWorker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'livequery-chat', extendedLifetime: true } as WorkerOptions)
    const linker = new ServiceLinker(new SharedWorkerChannel(worker))
    return { client: createRemoteLivequeryClient(linker.linkService<any>('livequery')), host: 'shared-worker' as Host }
}

export const { client, host } = connect()
