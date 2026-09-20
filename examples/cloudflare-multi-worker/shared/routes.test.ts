import { describe, expect, test } from 'bun:test'
import { matchGatewayRoute } from './routes.js'

describe('Cloudflare multi-worker gateway routes', () => {
    test('routes task collection and document requests', () => {
        expect(matchGatewayRoute('GET', '/livequery/tasks')?.binding).toBe('TASKS_SERVICE')
        expect(matchGatewayRoute('PATCH', '/livequery/tasks/task-1')?.binding).toBe('TASKS_SERVICE')
    })

    test('routes incident collection and document requests', () => {
        expect(matchGatewayRoute('POST', '/livequery/incidents')?.binding).toBe('INCIDENTS_SERVICE')
        expect(matchGatewayRoute('DELETE', '/livequery/incidents/incident-1')?.binding)
            .toBe('INCIDENTS_SERVICE')
    })

    test('does not route unsupported methods or unknown paths', () => {
        expect(matchGatewayRoute('POST', '/livequery/tasks/task-1')).toBeUndefined()
        expect(matchGatewayRoute('GET', '/livequery/elevators')).toBeUndefined()
    })
})
