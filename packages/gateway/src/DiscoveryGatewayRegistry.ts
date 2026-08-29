import { isDiscoveryOfflineData, type Discovery } from '@livequery/discovery'
import type { ServiceManifest } from '@livequery/service'
import { ApiGatewayHandler } from './ApiGatewayHandler.js'

type Subscription = { unsubscribe(): void }

/** Bridges an optional runtime discovery transport into the pure gateway engine. */
export class DiscoveryGatewayRegistry {
  readonly #subscription: Subscription

  constructor(discovery: Discovery<ServiceManifest>, gateway: ApiGatewayHandler) {
    this.#subscription = discovery.subscribe(message => {
      if (isDiscoveryOfflineData(message.data)) gateway.deregister(message.node_id)
      else gateway.applyManifest(message.data)
    })
  }

  close(): void {
    this.#subscription.unsubscribe()
  }
}
