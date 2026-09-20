import type { LivequeryRequest } from '@livequery/core/workers'

export type Env = {
    DB: D1Database
    GATEWAY: DurableObjectNamespace
    /** Comma-separated bearer tokens (a secret: `wrangler secret put API_TOKENS`). */
    API_TOKENS?: string
    /** `"true"` lets requests without a token through as the `anonymous` principal. */
    ALLOW_ANONYMOUS?: string
    /** Number of realtime Durable Object shards. Default 4. */
    REALTIME_SHARDS?: string
}

export type AppEnv = {
    Bindings: Env
    Variables: {
        principal: string
        livequery: LivequeryRequest
    }
}
