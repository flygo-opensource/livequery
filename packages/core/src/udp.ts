/**
 * UDP discovery entry point — `@livequery/core/udp`.
 *
 *   import { UdpDiscovery } from '@livequery/core/udp'
 *
 * Kept out of `/node` and `/bun` because it loads `@ohayo/udp`, an optional peer dependency:
 * importing those entries must not fail for apps that use HTTP discovery.
 */
export * from './UdpDiscovery.js'
