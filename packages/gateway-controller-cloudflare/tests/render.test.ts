import { expect, test } from 'bun:test'
import { renderCloudflarePlan } from '../src/index.js'
import type { ServiceManifest } from '@livequery/service'

test('preserves an explicit Service Binding endpoint', () => {
  const manifest: ServiceManifest = {
    schemaVersion: 1, serviceId: 'billing', instanceId: 'billing-deploy', version: '1', protocolVersion: '1',
    endpoint: { kind: 'binding', binding: 'BILLING_SERVICE' },
    routes: [{ id: 'billing', method: 'POST', path: '/billing', auth: 'required' }],
    status: 'ready', seq: 1, updatedAt: 1,
  }
  expect(renderCloudflarePlan([manifest])[0]?.binding).toBe('BILLING_SERVICE')
})
