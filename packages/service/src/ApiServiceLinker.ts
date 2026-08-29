import type { ServiceManifest, ServiceManifestInput } from './ServiceManifest.js'
import type { ServicePublisher } from './ServicePublisher.js'

export type ApiServiceLinkerOptions = {
  manifest: ServiceManifestInput
  publisher: ServicePublisher
}

function randomId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 10)).join('-')
}

/**
 * Owns the service publication lifecycle. It deliberately knows nothing about
 * Nginx, Kong, Kubernetes, Cloudflare, UDP, files, or a concrete WebSocket gateway.
 */
export class ApiServiceLinker {
  readonly #publisher: ServicePublisher
  #manifest: ServiceManifest
  #closed = false

  constructor({ manifest, publisher }: ApiServiceLinkerOptions) {
    this.#publisher = publisher
    this.#manifest = {
      ...manifest,
      instanceId: manifest.instanceId ?? randomId(),
      status: manifest.status ?? 'starting',
      seq: manifest.seq ?? 0,
      updatedAt: manifest.updatedAt ?? Date.now(),
      routes: manifest.routes.map(route => ({
        ...route,
        method: route.method.toUpperCase(),
      })),
    }
  }

  get manifest(): Readonly<ServiceManifest> {
    return this.#manifest
  }

  async start(): Promise<void> {
    await this.#transition(this.#manifest.status === 'ready' ? 'ready' : 'starting')
  }

  async ready(): Promise<void> {
    await this.#transition('ready')
  }

  async draining(): Promise<void> {
    await this.#transition('draining')
  }

  async update(patch: Partial<Pick<ServiceManifest, 'version' | 'endpoint' | 'routes' | 'health' | 'realtime'>>): Promise<void> {
    this.#assertOpen()
    this.#manifest = {
      ...this.#manifest,
      ...patch,
      routes: (patch.routes ?? this.#manifest.routes).map(route => ({
        ...route,
        method: route.method.toUpperCase(),
      })),
    }
    await this.#publish()
  }

  async close(): Promise<void> {
    if (this.#closed) return
    try {
      await this.#transition('offline')
    } finally {
      this.#closed = true
      await this.#publisher.close?.()
    }
  }

  async #transition(status: ServiceManifest['status']): Promise<void> {
    this.#assertOpen()
    this.#manifest = { ...this.#manifest, status }
    await this.#publish()
  }

  async #publish(): Promise<void> {
    const now = Date.now()
    this.#manifest = {
      ...this.#manifest,
      seq: this.#manifest.seq + 1,
      updatedAt: Math.max(now, this.#manifest.updatedAt + 1),
    }
    await this.#publisher.publish(this.#manifest)
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('ApiServiceLinker is closed')
  }
}
