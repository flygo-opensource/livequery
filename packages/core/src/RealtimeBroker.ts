import type { UpdatedData } from './LivequeryBaseEntity.js'

export type LivequeryChangeEvent = UpdatedData & {
  eventId: string
  serviceId: string
  tenantId?: string
  occurredAt: number
}

export interface RealtimeEventPublisher {
  publish(event: LivequeryChangeEvent): Promise<void>
}

export interface RealtimeEventConsumer {
  subscribe(handler: (event: LivequeryChangeEvent) => void | Promise<void>): Promise<() => Promise<void> | void>
}
