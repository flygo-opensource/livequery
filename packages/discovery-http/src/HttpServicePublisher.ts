import type { DiscoveryMessage } from '@livequery/discovery'
import type { ServiceManifest, ServicePublisher } from '@livequery/service'
import { HttpDiscovery, type HttpDiscoveryOptions } from './HttpDiscovery.js'

export type HttpServicePublisherOptions = Omit<HttpDiscoveryOptions, 'node_id' | 'listen'> & {
  tags?: string[]
}

export class HttpServicePublisher implements ServicePublisher {
  readonly #options: HttpServicePublisherOptions
  #discovery?: HttpDiscovery<ServiceManifest>

  constructor(options: HttpServicePublisherOptions) {
    this.#options = options
  }

  async publish(manifest: ServiceManifest): Promise<void> {
    const discovery = this.#discovery ??= new HttpDiscovery<ServiceManifest>({
      ...this.#options,
      tags: this.#options.tags ?? ['livequery', 'service'],
      node_id: manifest.instanceId,
      listen: false,
    })
    await discovery.broadcast(this.#message(manifest))
  }

  close(): void {
    this.#discovery?.close()
    this.#discovery = undefined
  }

  #message(manifest: ServiceManifest): DiscoveryMessage<ServiceManifest> {
    return {
      node_id: manifest.instanceId,
      namespace: this.#options.namespace,
      tags: this.#options.tags ?? ['livequery', 'service'],
      version: manifest.version,
      created_at: manifest.updatedAt,
      seq: manifest.seq,
      data: manifest,
    }
  }
}
