import { ServiceLinker, SharedWorkerChannel } from '@livequery/rpc'
import { ChatService } from './ChatService'

/** What a tab calls. Remote calls return awaitable observables, so both hosts fit this type. */
export type ChatApi = Pick<ChatService,
    'accounts' | 'chats' | 'moreChats' | 'chat' | 'messages' | 'olderMessages' | 'status'
    | 'join' | 'createChat' | 'send' | 'retry' | 'discard' | 'markRead' | 'setOffline'>

export type Host = 'shared-worker' | 'tab'

function connect(): { api: ChatApi, host: Host } {
    if (typeof SharedWorker === 'undefined') {
        // Chrome on Android: no SharedWorker, so this tab runs its own service.
        return { api: new ChatService(window.location.origin), host: 'tab' }
    }
    const worker = new SharedWorker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'livequery-chat' })
    const linker = new ServiceLinker(new SharedWorkerChannel(worker))
    return { api: linker.linkService<any>('chat') as ChatApi, host: 'shared-worker' }
}

export const { api: chat, host } = connect()
