import type { ServiceManifest } from './ServiceManifest.js'

export interface ServicePublisher {
  publish(manifest: ServiceManifest): Promise<void>
  close?(): Promise<void> | void
}

export class NoopServicePublisher implements ServicePublisher {
  async publish(_manifest: ServiceManifest): Promise<void> {}
  close(): void {}
}
