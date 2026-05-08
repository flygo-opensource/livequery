import { RpcChannel, type RpcMessage } from "./RpcChannel.js"

type RuntimeMessageListener = (message: unknown, sender: { tab?: { id: string } }, sendResponse: (response?: unknown) => void) => void

type ExtensionRuntime = {
    sendMessage(message: unknown): void
    onMessage: {
        addListener(listener: RuntimeMessageListener): void
        removeListener(listener: RuntimeMessageListener): void
    }
}

const chrome = (globalThis as typeof globalThis & {
    chrome?: {
        runtime: ExtensionRuntime
        tabs: {
            sendMessage(tabId: string, message: unknown): void
        }
    }
}).chrome

function isRpcMessage(value: unknown): value is RpcMessage {
    return !!value && typeof value === "object" && "id" in value
}

export class ExtensionChannel extends RpcChannel {



    constructor() {
        super()
        if (typeof window == 'undefined') {
            this.#initBackground()
        } else {
            this.#initForegound()
        }
    }

    #initForegound() {
        if (!chrome) return
        const runtime = chrome.runtime
        runtime?.onMessage.addListener((message, sender, sendResponse) => {
            if (!isRpcMessage(message)) return
            const respond = (response: RpcMessage['response']) => {
                runtime?.sendMessage({
                    id: message.id,
                    response
                } satisfies RpcMessage)
            }
            this.next({ ...message, respond })
        });
    }

    #initBackground() {
        if (!chrome) return
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            if (!isRpcMessage(message)) return
            const tabId = sender.tab?.id
            const respond = (response: RpcMessage['response']) => {
                if (tabId) {
                    chrome.tabs.sendMessage(tabId, {
                        id: message.id,
                        response
                    } satisfies RpcMessage)
                } else {
                    chrome.runtime.sendMessage({
                        id: message.id,
                        response
                    } satisfies RpcMessage)
                }
            }
            this.next({ ...message, respond })
        });
    }


    send(message: RpcMessage): void {
        if (!chrome) return
        chrome.runtime.sendMessage(message)
    }
}