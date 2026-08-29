import { describe, expect, test } from 'bun:test'
import { ApiServiceLinker, type ServiceManifest, type ServicePublisher } from '../src/index.js'

class MemoryPublisher implements ServicePublisher {
  readonly manifests: ServiceManifest[] = []
  closed = false
  async publish(manifest: ServiceManifest): Promise<void> {
    this.manifests.push(structuredClone(manifest))
  }
  close(): void { this.closed = true }
}

describe('ApiServiceLinker', () => {
  test('publishes lifecycle transitions without knowing a gateway runtime', async () => {
    const publisher = new MemoryPublisher()
    const linker = new ApiServiceLinker({
      publisher,
      manifest: {
        schemaVersion: 1,
        serviceId: 'orders',
        version: '1.0.0',
        protocolVersion: '1',
        endpoint: { protocol: 'http', host: 'orders', port: 3000 },
        routes: [{ id: 'orders-list', method: 'get', path: '/orders', auth: 'required' }],
      },
    })

    await linker.start()
    await linker.ready()
    await linker.draining()
    await linker.close()
    await linker.close()

    expect(publisher.manifests.map(item => item.status)).toEqual(['starting', 'ready', 'draining', 'offline'])
    expect(publisher.manifests[0]?.routes[0]?.method).toBe('GET')
    expect(publisher.manifests.map(item => item.seq)).toEqual([1, 2, 3, 4])
    expect(publisher.closed).toBe(true)
  })
})
