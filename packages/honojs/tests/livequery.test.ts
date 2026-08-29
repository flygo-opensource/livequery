import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import {
    createLivequery,
    collectServicePaths,
    getLivequeryRequest,
    livequeryJson,
    WebsocketGateway,
} from '../src/index.js'

describe('@livequery/honojs middleware', () => {
    test('parses a collection request and stores LivequeryRequest in context', async () => {
        const app = new Hono()
        const livequery = createLivequery(app)

        livequery.get('/livequery/products', c => {
            const req = getLivequeryRequest(c)
            return c.json({
                ref: req.ref,
                collection_ref: req.collection_ref,
                method: req.method,
            })
        })

        const res = await app.request('/livequery/products?limit=10')
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            ref: 'products',
            collection_ref: 'products',
            method: 'GET',
        })
    })

    test('parses params for document routes', async () => {
        const app = new Hono()
        const livequery = createLivequery(app)

        livequery.get('/livequery/products/:id', c => {
            const req = getLivequeryRequest(c)
            return c.json({
                ref: req.ref,
                document_id: req.document_id,
                keys: req.keys,
            })
        })

        const res = await app.request('/livequery/products/p-1')
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            ref: 'products/p-1',
            document_id: 'p-1',
            keys: { id: 'p-1' },
        })
    })

    test('livequeryJson hides private fields', async () => {
        const app = new Hono()
        app.get('/x', c => livequeryJson(c, {
            item: { _id: 'a', name: 'Alpha', _secret: 'hidden' },
        }))

        const res = await app.request('/x')
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            item: { id: 'a', name: 'Alpha' },
        })
    })

    test('registers realtime subscription for GET with client headers', async () => {
        const app = new Hono()
        const gateway = Object.create(WebsocketGateway.prototype) as WebsocketGateway & {
            listened?: unknown[]
        }
        Object.defineProperty(gateway, 'id', { value: 'gw-1' })
        gateway.listen = events => { gateway.listened = events }

        const livequery = createLivequery(app, { websocketGateway: gateway })
        livequery.get('/livequery/products', c => c.json({ ok: true }))

        const res = await app.request('/livequery/products', {
            headers: { 'x-lcid': 'client-1' },
        })

        expect(res.status).toBe(200)
        expect(gateway.listened).toEqual([{
            client_id: 'client-1',
            gateway_id: 'gw-1',
            listener_node_id: 'gw-1',
            ref: 'products',
        }])
    })

    test('does not register realtime subscription when cursor is present', async () => {
        const app = new Hono()
        const gateway = Object.create(WebsocketGateway.prototype) as WebsocketGateway & {
            listened?: unknown[]
        }
        Object.defineProperty(gateway, 'id', { value: 'gw-1' })
        gateway.listen = events => { gateway.listened = events }

        const livequery = createLivequery(app, { websocketGateway: gateway })
        livequery.get('/livequery/products', c => c.json({ ok: true }))

        const res = await app.request('/livequery/products?:after=abc', {
            headers: { 'x-lcid': 'client-1' },
        })

        expect(res.status).toBe(200)
        expect(gateway.listened).toBeUndefined()
    })

    test('route registry tracks service paths', () => {
        const app = new Hono()
        const livequery = createLivequery(app)
        livequery.get('/livequery/products/:id', c => c.json({ ok: true }))
        livequery.post('/livequery/products', c => c.json({ ok: true }))

        expect(livequery.registry.routes).toEqual([
            { method: 'GET', path: 'livequery/products/:id' },
            { method: 'POST', path: 'livequery/products' },
        ])
    })

    test('collectServicePaths reads routes from plain Hono app', () => {
        const app = new Hono()
        app.get('/livequery/products/:id', c => c.json({ ok: true }))
        app.post('/livequery/products', c => c.json({ ok: true }))

        expect(collectServicePaths(app)).toEqual([
            { method: 'GET', path: 'livequery/products/:id' },
            { method: 'POST', path: 'livequery/products' },
        ])
    })
})
