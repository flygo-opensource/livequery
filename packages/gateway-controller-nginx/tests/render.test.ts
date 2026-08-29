import { expect, test } from 'bun:test'
import { renderNginxConfig } from '../src/index.js'
import type { ServiceManifest } from '@livequery/service'

test('renders replicas as one upstream', () => {
  const base = { schemaVersion: 1, serviceId: 'users', version: '1', protocolVersion: '1', routes: [{ id: 'users', method: 'GET', path: '/users/:id', auth: 'required' }], status: 'ready', seq: 1, updatedAt: 1 } as const
  const manifests: ServiceManifest[] = [
    { ...base, instanceId: 'a', endpoint: { protocol: 'http', host: 'users-a', port: 3000 } },
    { ...base, instanceId: 'b', endpoint: { protocol: 'http', host: 'users-b', port: 3000 } },
  ]
  const config = renderNginxConfig(manifests)
  expect(config).toContain('server users-a:3000;')
  expect(config).toContain('server users-b:3000;')
})
