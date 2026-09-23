# @livequery/discovery

Service discovery for a Livequery API gateway on **Node and Bun** — the gateway learns which
services exist, where they are and which path prefixes they own from the services themselves, over
UDP on the LAN ([`@simple-discovery/udp`](https://www.npmjs.com/package/@simple-discovery/udp)).
Adding a service, or a second instance of one, needs no gateway change.

Cloudflare Workers keep the declared routing (Service Bindings): this package is never imported
there.

## Install

```bash
bun add @livequery/discovery
```

## Service

```ts
import { announceService } from '@livequery/discovery'

const app = new Hono()
app.get('/livequery/tasks', validator(Task), livequery(), source, realtime())
// ...

const announced = announceService({ name: 'tasks', port: 8081, app })   // or prefixes: ['/livequery/tasks']
process.once('SIGTERM', () => announced.close().finally(() => process.exit(0)))
export default serve(app, { port: 8081 })
```

- `app` announces every `/livequery/*` route of a Hono app; `prefixes` lists them explicitly.
- The announcement repeats every `interval` (5s): UDP has no "gone" signal. `close()` sends a last
  one saying the service is leaving, so gateways drop it at once.
- Gateways reach it at the address its announcement came from and `port`; pass `url` when that is
  not the right one (NAT, a proxy in front).

## Gateway

```ts
import { discoverServices } from '@livequery/discovery'

const directory = discoverServices()                          // optionally { routing: declared }
app.use('*', gateway({ routing: directory.routing, realtime }))
```

- Instances of the same service share its traffic in turn (round-robin per request).
- An instance silent for `ttl` (15s) is dropped; one that says it is leaving, at once.
- On start the gateway says hello, so services already running answer right away.
- `routing` merges with a declared routing if you pass one; discovered services win on the same
  prefix. `:param` names do not need to match across services.
- `directory.services()` lists what is known now — for a health endpoint.

## Network and security

Both sides use the `@simple-discovery/udp` settings, from options (`udp: { ... }`) or environment:

| Variable | Meaning |
| --- | --- |
| `SIMPLE_DISCOVERY_KEY` | **Always set it**, the same secret on gateways and services. Packets are signed with it; the default key is public. |
| `SIMPLE_DISCOVERY_PORT` | UDP port, default 11001. Open it between the machines. |
| `SIMPLE_DISCOVERY_UDP_MULTICAST=off` + `SIMPLE_DISCOVERY_UDP_WHITELIST_ADDRESS=host1,host2` | Networks without multicast (VPNs such as NetBird or WireGuard): list the peers. |

Clocks must be in sync (NTP): packets more than 30s off are dropped silently.

One announcement often arrives through several interfaces of a host (LAN, VPN, Docker bridges), each
with its own source address — 20 of them on a Docker host in our tests. The gateway keeps the first
address it heard for an instance (loopback when the service runs on the same machine) instead of
following the last copy.

Another transport of `@simple-discovery` (HTTP, NATS, Redis, AMQP) can be passed as `transport`
on both sides.

## Known limits

- On **macOS**, two **Bun** processes on one machine sharing the discovery port do not both receive:
  the one started second hears nothing. Linux is fine (checked with every Node/Bun pair). For
  local development on a Mac, run the gateway or the service on Node, or start the gateway first.
- Discovery says where a service is; it does not check that it answers. A service that dies
  without saying goodbye stays routed for up to `ttl`, and those requests fail.
