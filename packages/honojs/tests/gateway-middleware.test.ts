import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import {
    LIVEQUERY_CHANGE_HEADER,
    LIVEQUERY_REF_HEADER,
    type RealtimeSubscription,
    type ServiceRouting,
    type UpdatedData,
} from '@livequery/core'
import { gateway } from '../src/index.js'

type Call = { url: string; method: string; lcid: string | null }

function makeService(calls: Call[], answer: (request: Request) => Response) {
    return {
        fetch(request: Request) {
            calls.push({ url: request.url, method: request.method, lcid: request.headers.get('x-lcid') })
            return Promise.resolve(answer(request))
        },
    }
}

const routing: ServiceRouting = {
    services: { tasks: { binding: 'TASKS_SERVICE' } },
    routes: { livequery: { tasks: { $service: 'tasks' } } },
}

function makeApp(service: { fetch(request: Request): Promise<Response> }, options: Parameters<typeof gateway>[0]) {
    const app = new Hono<{ Bindings: { TASKS_SERVICE: typeof service } }>()
    app.use('*', gateway(options as never))
    app.all('*', c => c.json({ error: { code: 'NOT_FOUND' } }, 404))
    return (path: string, init?: RequestInit) =>
        app.request(path, init, { TASKS_SERVICE: service })
}

// ─── proxying ──────────────────────────────────────────────────────────────────

describe('gateway() — routing that changes', () => {
    test('a routing function is asked on every request; a failed service is reported', async () => {
        const failing = { fetch: () => Promise.reject(new TypeError('connection refused')) }
        let asked = 0
        const reported: Array<{ name: string, error: unknown }> = []
        const request = makeApp(failing, {
            routing: () => { asked++; return routing },
            onServiceError: (service, error) => reported.push({ name: service.name, error }),
        })
        const response = await request('/livequery/tasks')
        expect(asked).toBe(1)
        expect(response.status).toBe(500)
        expect(reported).toHaveLength(1)
        expect(reported[0]!.name).toBe('tasks')
        expect(String(reported[0]!.error)).toContain('connection refused')
    })
})

describe('gateway()', () => {
    test('forwards an owned prefix to its service binding', async () => {
        const calls: Call[] = []
        const service = makeService(calls, () => Response.json({ items: [] }))
        const request = makeApp(service, { routing })

        const res = await request('/livequery/tasks/t1/comments', { headers: { 'x-lcid': 'c1' } })
        expect(res.status).toBe(200)
        expect(calls).toHaveLength(1)
        expect(new URL(calls[0].url).pathname).toBe('/livequery/tasks/t1/comments')
        expect(calls[0].lcid).toBe('c1')
    })

    test('an unowned path falls through to the next handler', async () => {
        const calls: Call[] = []
        const request = makeApp(makeService(calls, () => Response.json({})), { routing })

        const res = await request('/health')
        expect(res.status).toBe(404)
        expect(calls).toHaveLength(0)
    })

    test('realtime headers from the service never reach the client', async () => {
        const service = makeService([], () => Response.json({ items: [] }, {
            headers: { [LIVEQUERY_REF_HEADER]: 'tasks' },
        }))
        const request = makeApp(service, { routing })

        const res = await request('/livequery/tasks', { headers: { 'x-lcid': 'c1' } })
        expect(res.headers.get(LIVEQUERY_REF_HEADER)).toBeNull()
        expect(await res.json()).toEqual({ items: [] })
    })
})

// ─── realtime on behalf of the service ─────────────────────────────────────────

describe('gateway() realtime', () => {
    test('registers the caller for the ref the service reports', async () => {
        const registered: RealtimeSubscription[] = []
        const service = makeService([], () => Response.json({ item: { id: 't1' } }, {
            headers: { [LIVEQUERY_REF_HEADER]: 'tasks/t1' },
        }))
        const request = makeApp(service, {
            routing,
            realtime: { register: (subscription: RealtimeSubscription) => { registered.push(subscription) } },
            principal: () => 'alice',
        })

        await request('/livequery/tasks/t1', { headers: { 'x-lcid': 'c1', 'x-lgid': 'do-1' } })
        expect(registered).toEqual([{
            ref: 'tasks/t1',
            client_id: 'c1',
            gateway_id: 'do-1',
            listener_node_id: 'do-1',
        }])
    })

    test('publishes the item the service returned', async () => {
        const published: UpdatedData[] = []
        const service = makeService([], () => Response.json({ item: { id: 't1', status: 'done' } }, {
            headers: { [LIVEQUERY_CHANGE_HEADER]: 'modified tasks' },
        }))
        const request = makeApp(service, {
            routing,
            realtime: { publish: (update: UpdatedData) => { published.push(update) } },
        })

        const res = await request('/livequery/tasks/t1', { method: 'PATCH' })
        expect(res.status).toBe(200)
        expect(published).toEqual([{ ref: 'tasks', type: 'modified', data: { id: 't1', status: 'done' } }])
    })

    test('an in-process gateway is driven directly, as on Node and Bun', async () => {
        const listened: RealtimeSubscription[][] = []
        const published: UpdatedData[] = []
        const realtime = {
            id: 'gw-1',
            listen: (events: RealtimeSubscription[]) => listened.push(events),
            next: (update: UpdatedData) => published.push(update),
        }
        const read = makeService([], () => Response.json({ items: [] }, { headers: { [LIVEQUERY_REF_HEADER]: 'tasks' } }))
        await makeApp(read, { routing, realtime })('/livequery/tasks', { headers: { 'x-lcid': 'c1' } })

        const write = makeService([], () => Response.json({ item: { id: 't1' } }, {
            headers: { [LIVEQUERY_CHANGE_HEADER]: 'added tasks' },
        }))
        await makeApp(write, { routing, realtime })('/livequery/tasks', { method: 'POST' })

        expect(listened).toEqual([[{ ref: 'tasks', client_id: 'c1', gateway_id: 'gw-1', listener_node_id: 'gw-1' }]])
        expect(published).toEqual([{ ref: 'tasks', type: 'added', data: { id: 't1' } }])
    })

    test('a failed service response is passed through untouched', async () => {
        const published: UpdatedData[] = []
        const service = makeService([], () => Response.json({ error: { code: 'FORBIDDEN' } }, {
            status: 403,
            headers: { [LIVEQUERY_CHANGE_HEADER]: 'added tasks' },
        }))
        const request = makeApp(service, { routing, realtime: { publish: (u: UpdatedData) => { published.push(u) } } })

        const res = await request('/livequery/tasks', { method: 'POST' })
        expect(res.status).toBe(403)
        expect(published).toEqual([])
        expect(res.headers.get(LIVEQUERY_CHANGE_HEADER)).toBeNull()
    })

    test('a failing realtime target does not fail the request', async () => {
        const service = makeService([], () => Response.json({ item: { id: 't1' } }, {
            headers: { [LIVEQUERY_CHANGE_HEADER]: 'added tasks' },
        }))
        const request = makeApp(service, {
            routing,
            realtime: { publish: () => { throw new Error('shard unreachable') } },
        })

        const res = await request('/livequery/tasks', { method: 'POST' })
        expect(res.status).toBe(200)
    })
})
