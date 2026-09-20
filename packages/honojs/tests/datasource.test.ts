import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { createDatasourceMapper, createLivequery, type MappedDatasource } from '../src/index.js'

type RouteOptions = { table: string }

describe('createDatasourceMapper', () => {
    test('accepts a plain datasource with init and query, e.g. D1Datasource', async () => {
        const initialized: unknown[] = []
        const datasource: MappedDatasource<RouteOptions> = {
            async init(routes) { initialized.push(...routes) },
            async query(req, options) {
                return { items: [{ id: 't1', table: options.table, ref: req.ref, _secret: 'x' }] }
            },
        }
        const routes = [{ method: 'GET', path: '/livequery/tasks', options: { table: 'tasks' } }]
        const use = await createDatasourceMapper({ datasource, routes })

        const app = new Hono()
        const livequery = createLivequery(app)
        livequery.get('/livequery/tasks', use({ table: 'tasks' }))

        const res = await app.request('/livequery/tasks')
        expect(initialized).toEqual([{ method: 'GET', path: '/livequery/tasks', table: 'tasks' }])
        expect(await res.json()).toEqual({ items: [{ id: 't1', table: 'tasks', ref: 'tasks' }] })
    })

    test('structured datasource errors map to their HTTP status', async () => {
        const datasource: MappedDatasource<RouteOptions> = {
            async init() {},
            async query() { throw { status: 400, code: 'INVALID_FIELD', message: 'bad field' } },
        }
        const use = await createDatasourceMapper({ datasource, routes: [] })
        const app = new Hono()
        createLivequery(app).get('/livequery/tasks', use({ table: 'tasks' }))

        const res = await app.request('/livequery/tasks')
        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({ error: { code: 'INVALID_FIELD', message: 'bad field' } })
    })
})
