import { describe, expect, test } from 'bun:test'
import { matchService, type ServiceRouting } from '../src/index.js'

const routing: ServiceRouting = {
    services: {
        tasks: { binding: 'TASKS_SERVICE', url: 'http://tasks:8081' },
        orders: { binding: 'ORDERS_SERVICE' },
        audit: { binding: 'AUDIT_SERVICE' },
    },
    routes: {
        livequery: {
            tasks: { $service: 'tasks' },
            customers: {
                ':customer_id': {
                    orders: {
                        $service: 'orders',
                        audit: { $service: 'audit' },
                    },
                },
            },
            public: { $service: 'tasks', $auth: 'public' },
        },
    },
}

describe('matchService', () => {
    test('a prefix owns everything below it, including routes the gateway never saw', () => {
        expect(matchService(routing, '/livequery/tasks')?.name).toBe('tasks')
        expect(matchService(routing, '/livequery/tasks/t1')?.name).toBe('tasks')
        expect(matchService(routing, '/livequery/tasks/t1~complete')?.name).toBe('tasks')
        expect(matchService(routing, '/livequery/tasks/t1/comments/c1')?.name).toBe('tasks')
    })

    test(':param matches any segment', () => {
        expect(matchService(routing, '/livequery/customers/c1/orders')?.name).toBe('orders')
        expect(matchService(routing, '/livequery/customers/anything/orders/o1')?.name).toBe('orders')
    })

    test('the deepest owner wins over the prefix above it', () => {
        expect(matchService(routing, '/livequery/customers/c1/orders/audit')?.name).toBe('audit')
        expect(matchService(routing, '/livequery/customers/c1/orders/audit/a1')?.name).toBe('audit')
    })

    test('$auth is inherited, and defaults to required', () => {
        expect(matchService(routing, '/livequery/tasks')?.auth).toBe('required')
        expect(matchService(routing, '/livequery/public/anything')?.auth).toBe('public')
    })

    test('an unowned path matches nothing', () => {
        expect(matchService(routing, '/health')).toBeUndefined()
        expect(matchService(routing, '/livequery')).toBeUndefined()
        expect(matchService(routing, '/livequery/unknown')).toBeUndefined()
    })

    test('the target carries the binding and the url, so each runtime picks its own', () => {
        expect(matchService(routing, '/livequery/tasks')?.target)
            .toEqual({ binding: 'TASKS_SERVICE', url: 'http://tasks:8081' })
    })

    test('routing that names a service it does not declare fails loudly', () => {
        const broken: ServiceRouting = { services: {}, routes: { livequery: { tasks: { $service: 'tasks' } } } }
        expect(() => matchService(broken, '/livequery/tasks')).toThrow('missing from services')
    })
})
