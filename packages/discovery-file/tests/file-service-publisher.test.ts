import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileServicePublisher } from '../src/index.js'

let directory: string | undefined
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }) })

describe('FileServicePublisher', () => {
  test('atomically exposes and removes an instance manifest', async () => {
    directory = await mkdtemp(join(tmpdir(), 'livequery-manifest-'))
    const publisher = new FileServicePublisher({ directory })
    await publisher.publish({
      schemaVersion: 1,
      serviceId: 'orders',
      instanceId: 'orders-1',
      version: '1.0.0',
      protocolVersion: '1',
      endpoint: { protocol: 'http', host: 'orders', port: 3000 },
      routes: [],
      status: 'ready',
      seq: 1,
      updatedAt: Date.now(),
    })
    const manifest = JSON.parse(await readFile(join(directory, 'orders-orders-1.json'), 'utf8'))
    expect(manifest.status).toBe('ready')
    await publisher.close()
    expect(await readFile(join(directory, 'orders-orders-1.json'), 'utf8').catch(() => undefined)).toBeUndefined()
  })
})
