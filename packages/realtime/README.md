# @livequery/realtime

Realtime protocol engine trung lập runtime và contract cho event broker.
`WebsocketGatewayBase` quản lý handshake, subscriptions, reconnect grace period,
gateway linking và phân phối `UpdatedData`.

## Cài đặt

```sh
bun add @livequery/realtime @livequery/protocol
```

Thông thường application không khởi tạo base class trực tiếp. Hãy dùng adapter:

- Node: `@livequery/realtime-node`.
- Bun: `@livequery/realtime-bun`.
- Cloudflare: `@livequery/realtime-cloudflare`.

## Publish update trực tiếp

```ts
gateway.next({
  ref: 'orders',
  type: 'modified',
  data: { id: 'order-42', status: 'paid' },
})
```

## Broker contracts

```ts
import type {
  LivequeryChangeEvent,
  RealtimeEventConsumer,
  RealtimeEventPublisher,
} from '@livequery/realtime'
```

`RealtimeEventPublisher` và `RealtimeEventConsumer` cho phép adapter NATS, Redis
Streams hoặc Kafka nằm ngoài protocol engine. Event phải có `eventId`,
`serviceId`, `occurredAt` và có thể có `tenantId`.

Package này không mở WebSocket server và không lưu durable subscription state.
