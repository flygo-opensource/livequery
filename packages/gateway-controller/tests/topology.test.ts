import { describe, expect, test } from 'bun:test'
import { createServiceTopology } from '../src/index.js'
import type { ServiceManifest } from '@livequery/service'

function manifest(serviceId: string, instanceId: string, path = '/users/:id'): ServiceManifest {
  return {
    schemaVersion: 1, serviceId, instanceId, version: '1', protocolVersion: '1',
    endpoint: { protocol: 'http', host: instanceId, port: 3000 },
    routes: [{ id: `${serviceId}-route`, method: 'GET', path, auth: 'required' }],
    status: 'ready', seq: 1, updatedAt: Date.now(),
  }
}

describe('createServiceTopology', () => {
  test('collapses replicas into one logical service', () => {
    const topology = createServiceTopology([manifest('users', 'users-a'), manifest('users', 'users-b')])
    expect(topology).toHaveLength(1)
    expect(topology[0]?.targets).toHaveLength(2)
  })

  test('rejects normalized route conflicts across services', () => {
    expect(() => createServiceTopology([
      manifest('users', 'users-a', '/users/:id'),
      manifest('admin', 'admin-a', '/users/:userId'),
    ])).toThrow('owned by both')
  })
})
