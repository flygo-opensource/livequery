import { UdpDiscovery, type UdpDiscoveryOptions } from '@simple-discovery/udp'
import { DISCOVERY_NAMESPACE, DISCOVERY_TAG } from './const.js'
import type { ServiceAnnouncement, ServiceDiscoveryTransport } from './types.js'

export type UdpTransportOptions = Partial<Omit<UdpDiscoveryOptions, 'tags'>>

/**
 * The default transport: UDP on the LAN, multicast or a list of peers. Configure it through its
 * options or its environment variables — `SIMPLE_DISCOVERY_KEY` (always set one: the default key is
 * public), `SIMPLE_DISCOVERY_PORT`, `SIMPLE_DISCOVERY_UDP_MULTICAST=off` and
 * `SIMPLE_DISCOVERY_UDP_WHITELIST_ADDRESS` for networks without multicast (VPNs).
 */
export function createUdpTransport(node_id: string, options: UdpTransportOptions = {}): ServiceDiscoveryTransport {
    return new UdpDiscovery<ServiceAnnouncement>({
        namespace: DISCOVERY_NAMESPACE,
        ...options,
        tags: [DISCOVERY_TAG],
        node_id,
    }) as unknown as ServiceDiscoveryTransport
}
