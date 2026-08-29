import { afterEach, describe, expect, test } from 'bun:test'
import { ApiGatewayHandler, RouteConflictError } from '../src/index.js'
import type { ServiceManifest } from '@livequery/service'

const servers: Array<{ stop(force?: boolean): void }> = []
afterEach(() => { for (const server of servers.splice(0)) server.stop(true) })

function manifest(serviceId: string, instanceId: string, port: number): ServiceManifest {
  return {
    schemaVersion: 1, serviceId, instanceId, version: '1', protocolVersion: '1',
    endpoint: { protocol: 'http', host: '127.0.0.1', port },
    routes: [{ id: 'get-user', method: 'GET', path: '/users/:id', auth: 'required' }],
    status: 'ready', seq: 1, updatedAt: Date.now(),
  }
}

describe('ApiGatewayHandler', () => {
  test('routes with Fetch API and round-robins replicas', async () => {
    for (const name of ['a', 'b']) {
      servers.push(Bun.serve({ port: 0, fetch: request => Response.json({ name, path: new URL(request.url).pathname }) }))
    }
    const gateway = new ApiGatewayHandler()
    gateway.register(manifest('users', 'users-a', (servers[0] as any).port))
    gateway.register(manifest('users', 'users-b', (servers[1] as any).port))
    const first = await gateway.fetch(new Request('http://gateway/users/42'))
    const second = await gateway.fetch(new Request('http://gateway/users/42'))
    expect([(await first.json()).name, (await second.json()).name]).toEqual(['a', 'b'])
  })

  test('rejects route ownership conflicts', () => {
    const gateway = new ApiGatewayHandler()
    gateway.register(manifest('users', 'users-a', 3001))
    expect(() => gateway.register(manifest('admin', 'admin-a', 3002))).toThrow(RouteConflictError)
  })

  test('normalizes parameter names when checking route ownership', () => {
    const gateway = new ApiGatewayHandler()
    gateway.register(manifest('users', 'users-a', 3001))
    const contender = manifest('admin', 'admin-a', 3002)
    contender.routes[0] = { ...contender.routes[0]!, path: '/users/:userId' }
    expect(() => gateway.register(contender)).toThrow(RouteConflictError)
  })
})
