# @livequery/discovery-http

HTTP registry transport cho Livequery. Gateway side có thể mở registry endpoint;
service side đăng ký, heartbeat và deregister qua HTTP.

## Cài đặt

```sh
bun add @livequery/discovery-http @livequery/service
```

## Gateway registry

```ts
import { HttpDiscovery } from '@livequery/discovery-http'
import type { ServiceManifest } from '@livequery/service'

const discovery = new HttpDiscovery<ServiceManifest>({
  namespace: 'production',
  tags: ['livequery'],
  key: process.env.OHAYO_DISCOVERY_KEY,
  port: 12001,
  listen: true,
})
```

Registry cung cấp:

- `POST /register`.
- `DELETE /register/:node_id`.
- `GET /health`.
- `GET /nodes` có Bearer authentication.

## Service publisher

```ts
import { HttpServicePublisher } from '@livequery/discovery-http'

const publisher = new HttpServicePublisher({
  namespace: 'production',
  tags: ['livequery', 'service'],
  key: process.env.OHAYO_DISCOVERY_KEY,
  gateways: ['http://gateway-control:12001'],
})
```

Các option đáng chú ý: `heartbeatMs`, `ttlMs`, `requestTimeoutMs`, `gateways` và
`listen`. Transport này cần Node/Bun HTTP compatibility và không dùng trong
Cloudflare Workers.
