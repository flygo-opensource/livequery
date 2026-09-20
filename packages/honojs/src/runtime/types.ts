/** Minimal Hono app shape `serve()` needs, so the runtime entries share one signature. */
export type FetchApp = {
    fetch(request: Request, ...rest: any[]): Response | Promise<Response>
}

export type ServeOptions = {
    /** Port for Node and Bun. Ignored on Workers, where the platform owns the port. */
    port?: number
    /**
     * Realtime gateway that owns the client WebSockets, on Node and Bun. Ignored on Workers,
     * where sockets live in a Durable Object.
     */
    realtime?: unknown
}
