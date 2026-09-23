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

const announced = await announceService({ name: 'tasks', port: 8081, app })   // or prefixes: ['/livequery/tasks']
export default serve(app, { port: 8081 })
```

- `app` announces every `/livequery/*` route of a Hono app; `prefixes` lists them explicitly.
- **No heartbeat.** The service announces once, and opens a small TCP probe port. A gateway started
  later gets the announcement in answer to its hello.
- Gateways reach it at the address that answered their probe connection, and `port`; pass `url`
  when that is not the right one (NAT, a proxy in front).
- `close()` closes the probe port: connected gateways drop the service at once. Killing the process
  does the same — the operating system closes its connections.

## Gateway

```ts
import { discoverServices } from '@livequery/discovery'

const directory = discoverServices()                          // optionally { routing: declared }
app.use('*', gateway({ routing: directory.routing, onServiceError: directory.unreachable, realtime }))
```

- **The gateway connects to every announced instance and keeps the connection open.** An instance
  is routed while its connection is up. When the connection closes — the service stopped, crashed
  or was killed — it is out at once, and the gateway keeps trying to reconnect (1s, 2s, 4s… up to
  30s), so a network blip heals by itself. After an hour unreachable it is forgotten.
- A machine that disappears without closing (power, cable) is noticed by TCP keepalive, or at the
  first failed request through `onServiceError` → `unreachable`, which takes the instance out and
  checks it again.
- An announcement heard through several interfaces is connected in this order: loopback, private
  LAN, other addresses, VPN/CGNAT (`100.64.0.0/10`) last; the first that answers is used.
- Instances of the same service share its traffic in turn (round-robin per request).
- On start the gateway says hello, so services already running answer right away.
- `routing` merges with a declared routing if you pass one; discovered services win on the same
  prefix. `:param` names do not need to match across services.
- `directory.services()` lists what is known now — for a health endpoint.

## Network and security

Both sides use the `@simple-discovery/udp` settings, from options (`udp: { ... }`) or environment:

| Variable | Meaning |
| --- | --- |
| `SIMPLE_DISCOVERY_KEY` | **Always set it**, the same secret on gateways and services. Packets are signed with it; the default key is public. |
| `SIMPLE_DISCOVERY_PORT` | UDP port, default 11001. Open it between the machines, and the services' TCP probe ports (ephemeral) from gateways to services. |
| `SIMPLE_DISCOVERY_UDP_MULTICAST=off` + `SIMPLE_DISCOVERY_UDP_WHITELIST_ADDRESS=host1,host2` | Networks without multicast (VPNs such as NetBird or WireGuard): list the peers. |

Clocks must be in sync (NTP): packets more than 30s off are dropped silently.

Another transport of `@simple-discovery` (HTTP, NATS, Redis, AMQP) can be passed as `transport`
on both sides.

## Known limits

- On **macOS**, two **Bun** processes on one machine sharing the discovery port do not both receive:
  the one started second hears nothing. Linux is fine (checked with every Node/Bun pair). For
  local development on a Mac, run the gateway or the service on Node, or start the gateway first.
- The probe connection says the service process is there; it does not say its HTTP server answers.
  A service that hangs without exiting stays routed; `onServiceError` catches refused connections,
  not slow ones.
