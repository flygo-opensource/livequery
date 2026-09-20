export type DurableObjectId = unknown

export type DurableObjectStubLike = {
    fetch(request: Request): Promise<Response>
}

export type DurableObjectNamespaceLike = {
    idFromName(name: string): DurableObjectId
    idFromString?(id: string): DurableObjectId
    get(id: DurableObjectId): DurableObjectStubLike
}

/** The subset of a Workers `WebSocket` that the hibernating gateway touches. */
export type HibernatableWebSocket = {
    readonly readyState: number
    send(data: string): void
    close(code?: number, reason?: string): void
    serializeAttachment(value: unknown): void
    deserializeAttachment(): unknown
}

/** The subset of `DurableObjectState` that the hibernating gateway touches. */
export type DurableObjectStateLike = {
    readonly id: { toString(): string }
    readonly storage: {
        list<T>(options: { prefix: string }): Promise<Map<string, T>>
        put<T>(key: string, value: T): Promise<void>
        delete(keys: string[]): Promise<number>
    }
    acceptWebSocket(ws: HibernatableWebSocket, tags?: string[]): void
    getWebSockets(tag?: string): HibernatableWebSocket[]
    setWebSocketAutoResponse?(pair?: unknown): void
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>
}
