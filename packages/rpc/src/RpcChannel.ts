import { Subject } from "rxjs"


export type RpcMessage = {
    id: number
    request?: {
        service: string
        method: string[]
        args: any[]
    }
    cancel?: boolean
    response?: Partial<{
        data: any
        error: string
        completed: boolean
    }>
}


export abstract class RpcChannel extends Subject<RpcMessage & { respond: (msg: RpcMessage) => void }> {
    abstract send(message: RpcMessage): void
}