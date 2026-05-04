import { RpcChannel, type RpcMessage } from "./RpcChannel.js"

type RuntimeMessageListener = (message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => void

type ExtensionRuntime = {
    sendMessage(message: unknown): void
    onMessage: {
        addListener(listener: RuntimeMessageListener): void
        removeListener(listener: RuntimeMessageListener): void
    }
}

const runtime = (() => {
    const runtime = (globalThis as typeof globalThis & {
        chrome?: { runtime?: ExtensionRuntime }
    }).chrome?.runtime

    if (!runtime) {
        throw new Error("chrome.runtime is not available")
    }

    return runtime
})()

function isRpcMessage(value: unknown): value is RpcMessage {
    return !!value && typeof value === "object" && "id" in value
}

export class ExtensionChannel extends RpcChannel {

    constructor() {
        super()

        runtime.onMessage.addListener(this.#onMessage)
    }

    #onMessage = (message: unknown) => {
        if (!isRpcMessage(message)) return

        const respond = (response: RpcMessage['response']) => {
            runtime.sendMessage({
                id: message.id,
                response
            } satisfies RpcMessage)
        }

        this.next({ ...message, respond })
    }

    send(message: RpcMessage): void {
        runtime.sendMessage(message)
    }
}