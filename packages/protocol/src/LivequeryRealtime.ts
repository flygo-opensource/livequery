import type { UpdatedData } from './LivequeryBaseEntity.js'

/** Default realtime endpoint defined by the Livequery protocol. */
export const LIVEQUERY_REALTIME_PATH = '/livequery/realtime-updates'

export type RealtimeSubscription = {
    ref: string
    client_id: string
    gateway_id: string
    listener_node_id: string
}

export type LivequeryStartEvent = {
    event: 'start'
    data: {
        id: string
        auth: string
    }
}

export type LivequeryHelloEvent = {
    event: 'hello'
    gid: string
    binary: boolean
}

export type LivequerySubscribeEvent = {
    event: 'subscribe'
} & RealtimeSubscription

export type LivequeryUnsubscribeEvent = {
    event: 'unsubscribe'
    data: {
        ref?: string
        refs?: string[]
        client_id: string
    }
}

export type LivequerySyncEvent = {
    event: 'sync'
    cids?: string[]
    data?: {
        changes: UpdatedData[]
    }
}

export type LivequeryRealtimeEvent =
    | LivequeryStartEvent
    | LivequeryHelloEvent
    | LivequerySubscribeEvent
    | LivequeryUnsubscribeEvent
    | LivequerySyncEvent

