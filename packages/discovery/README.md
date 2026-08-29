# @livequery/discovery

Contract transport-neutral cho service discovery. Package này định nghĩa Ohayo
envelope và interface mà HTTP/UDP transports cùng triển khai.

## Cài đặt

```sh
bun add @livequery/discovery
```

## Envelope

```ts
import type { DiscoveryMessage } from '@livequery/discovery'

const message: DiscoveryMessage<{ status: string }> = {
  node_id: 'orders-a',
  namespace: 'production',
  tags: ['livequery', 'service'],
  version: '1.2.0',
  created_at: Date.now(),
  seq: 42,
  data: { status: 'ready' },
}
```

## API chính

- `Discovery<T>`: observable transport với `broadcast()` và `close()`.
- `DiscoveryMessage<T>` và `DiscoveryEvent<T>`.
- `DiscoveryOfflineData`.
- `hasDiscoveryEnvelope`, `isDiscoveryOfflineData`, `containsAllTags`.

Transport phải lọc đúng namespace/tags. Việc deduplicate, kiểm tra `seq` cũ và
route ownership thuộc consumer, không thuộc contract này.
