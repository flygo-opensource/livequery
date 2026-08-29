import type { Observable } from 'rxjs'

export type DiscoveryMessage<T> = {
    node_id: string
    namespace: string
    tags: string[]
    version: string
    created_at: number
    seq: number
    data: T
    remote_host?: string
}

/** Backward-compatible name for an Ohayo discovery envelope. */
export type UdpDiscoveryNode<T = Record<string, unknown>> = DiscoveryMessage<T>

export type DiscoveryOptions = {
    namespace: string
    tags: string[]
    node_id?: string
}

export type DiscoveryOfflineData = {
    status: 'offline'
}

export type DiscoveryEvent<T> = DiscoveryMessage<T | DiscoveryOfflineData>

export interface Discovery<T> extends Observable<DiscoveryEvent<T>> {
    broadcast(message: DiscoveryMessage<T>): Promise<void>
    close(): void
}

export function isDiscoveryOfflineData(data: unknown): data is DiscoveryOfflineData {
    return typeof data === 'object'
        && data !== null
        && (data as { status?: unknown }).status === 'offline'
}

export function hasDiscoveryEnvelope<T>(value: unknown): value is DiscoveryMessage<T> {
    if (typeof value !== 'object' || value === null) return false
    const message = value as Partial<DiscoveryMessage<T>>
    return typeof message.node_id === 'string'
        && typeof message.namespace === 'string'
        && Array.isArray(message.tags)
        && typeof message.version === 'string'
        && typeof message.created_at === 'number'
        && typeof message.seq === 'number'
        && 'data' in message
}

export function containsAllTags(actual: readonly string[] | undefined, required: readonly string[]): boolean {
    if (!actual) return false
    return required.every(tag => actual.includes(tag))
}
