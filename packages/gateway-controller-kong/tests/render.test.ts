import { expect, test } from 'bun:test'
import { renderKongConfig } from '../src/index.js'
import type { ServiceManifest } from '@livequery/service'

test('renders a Kong upstream and service', () => {
  const manifest: ServiceManifest = {
    schemaVersion: 1, serviceId: 'orders', instanceId: 'orders-a', version: '1', protocolVersion: '1',
    endpoint: { protocol: 'http', host: 'orders-a', port: 3000 },
    routes: [{ id: 'orders', method: 'GET', path: '/orders', auth: 'required' }],
    status: 'ready', seq: 1, updatedAt: 1,
  }
  const config = renderKongConfig([manifest])
  expect(config.upstreams[0]?.targets[0]?.target).toBe('orders-a:3000')
  expect(config.services[0]?.name).toBe('orders')
})
