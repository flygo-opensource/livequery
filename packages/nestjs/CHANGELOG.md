# Changelog — @livequery/nestjs

## Unreleased

Nothing yet.

## 3.0.0

### Breaking
- Removed `ApiGateway` (also exported as `ApiGatewayLinker`) and `ApiServiceLinker`, including
  `ApiServiceLinker.broadcast()`, and the types `ApiGatewayClientOptions`, `ServiceApiMetadata`
  and `ServiceApiStatus`. They were part of the discovery-driven gateway, which is gone from
  `@livequery/core`. A gateway is now a Hono app that routes by path prefix; see
  `@livequery/honojs` `gateway({ routing })`. (cf0d9d5)
- Removed the `UdpDiscovery` re-export and its types (`UdpDiscoveryNode`, `UdpDiscoveryOptions`,
  `UdpDiscoveryPacket`, `UdpDiscoveryStatus`).
- Built on `@livequery/core` `^3.0.0` and its `/node` entry. `WebsocketGateway` and every
  re-exported type now come from `@livequery/core/node`. The gateway is no longer exported from
  the root `@livequery/core`, so `import { WebsocketGateway } from '@livequery/core'` no longer
  resolves. Import it from `@livequery/nestjs` or `@livequery/core/node`.
- Peer dependencies: `@livequery/core` `^3.0.0`, and new peers `ws` `^8.18.0` and `rxjs` `^7.8.1`.
  In 2.x, core brought `ws` along as a dependency.
- Through core 3.0: the `WebsocketGateway` ignores `subscribe` frames that a client sends itself.
  Subscriptions come from the interceptor after an authorized GET. To restore the old behaviour,
  pass `{ allowClientSubscribe: true }`. (fd0884d)

### Changed
- `tslib` is a runtime dependency (the build uses `importHelpers`).

Migrating from 2.x: see [MIGRATION.md](../../MIGRATION.md).

## 2.x

Released from the pre-monorepo repositories; no changelog was kept.
