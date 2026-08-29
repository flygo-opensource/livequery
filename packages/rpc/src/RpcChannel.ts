import { Subject } from "rxjs"


export type RpcMessage = {
    id: number
    request?: {
        service: string
        method: string[]
        args: any[]
    }
    cancel?: { id: number }
    // Emitted by a channel implementation when a connection (port) drops, so the
    // WorkerManager can release any streaming subscriptions tied to that connection.
    disconnect?: boolean
    response?: Partial<{
        data: any
        error?: {
            code:string 
            message: string
            stack?: string
        }
        completed: boolean
    }>
}


export abstract class RpcChannel extends Subject<RpcMessage & {
    respond: (msg: RpcMessage['response']) => void
    // Identifies the originating connection; set by channels that multiplex several
    // clients (e.g. SharedWorker). Lets the manager scope per-connection cleanup.
    connection_id?: string
}> {
    abstract send(message: RpcMessage): void
}