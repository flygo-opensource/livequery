import { describe, it, expect } from 'bun:test'
import { LivequeryRequestParser, type LivequeryContext } from '../src/index.js'

describe('LivequeryRequestParser', () => {
    it('parses a collection request', () => {
        const ctx = createContext({
            path: '/livequery/posts',
            ref: '/livequery/posts',
            query: { ':limit': '20' },
            method: 'GET'
        })

        new LivequeryRequestParser().handle(ctx)

        expect(ctx.livequery?.ref).toBe('posts')
        expect(ctx.livequery?.document_id).toBeUndefined()
        expect(ctx.livequery?.collection_ref).toBe('posts')
        expect(ctx.livequery?.method).toBe('GET')
        expect(ctx.livequery?.query).toEqual({ ':limit': '20' })
    })

    it('parses a document request', () => {
        const ctx = createContext({
            path: '/livequery/posts/abc',
            ref: '/livequery/posts/:id',
            params: { id: 'abc' },
            method: 'GET'
        })

        new LivequeryRequestParser().handle(ctx)

        expect(ctx.livequery?.ref).toBe('posts/abc')
        expect(ctx.livequery?.document_id).toBe('abc')
        expect(ctx.livequery?.keys).toEqual({ id: 'abc' })
    })

    it('computes schema_collection_ref from route pattern', () => {
        const ctx = createContext({
            path: '/livequery/users/u1/posts',
            ref: '/livequery/users/:uid/posts',
            params: { uid: 'u1' },
            method: 'GET'
        })

        new LivequeryRequestParser().handle(ctx)

        expect(ctx.livequery?.schema_collection_ref).toBe('users/uid/posts')
        expect(ctx.livequery?.ref).toBe('users/u1/posts')
    })

    it('uppercases the method', () => {
        const ctx = createContext({
            path: '/livequery/posts',
            ref: '/livequery/posts',
            method: 'post',
            body: { title: 'Hello' }
        })

        new LivequeryRequestParser().handle(ctx)

        expect(ctx.livequery?.method).toBe('POST')
        expect(ctx.livequery?.body).toEqual({ title: 'Hello' })
    })

    it('ignores query strings and realtime hotkey suffixes in the path', () => {
        const ctx = createContext({
            path: '/livequery/posts/abc~listen?x=1',
            ref: '/livequery/posts/:id',
            params: { id: 'abc' },
            query: { x: '1' },
            method: 'GET'
        })

        new LivequeryRequestParser().handle(ctx)

        expect(ctx.livequery?.ref).toBe('posts/abc')
        expect(ctx.livequery?.document_id).toBe('abc')
        expect(ctx.livequery?.path).toBe('/livequery/posts/abc~listen?x=1')
        expect(ctx.livequery?.query).toEqual({ x: '1' })
    })

    it('parses nested livequery document paths with param segments and hotkey suffixes', () => {
        const ctx = createContext({
            ref: 'livequery/spaces/:space_id/status/:type/orders/:id/~abc',
            path: 'livequery/spaces/space_xxx/status/running/orders/y8273678fgs8734/~abc',
            params: {
                space_id: 'space_xxx',
                type: 'running',
                id: 'y8273678fgs8734',
            },
            method: 'GET'
        })

        new LivequeryRequestParser().handle(ctx)

        expect(ctx.livequery?.ref).toBe('spaces/space_xxx/status/running/orders/y8273678fgs8734')
        expect(ctx.livequery?.collection_ref).toBe('spaces/space_xxx/status/running/orders')
        expect(ctx.livequery?.schema_collection_ref).toBe('spaces/space_id/status/type/orders')
        expect(ctx.livequery?.document_id).toBe('y8273678fgs8734')
        expect(ctx.livequery?.keys).toEqual({
            space_id: 'space_xxx',
            type: 'running',
            id: 'y8273678fgs8734',
        })
    })

    it('parses hotkey suffixes attached directly to the document id', () => {
        const ctx = createContext({
            ref: 'livequery/spaces/:space_id/status/:type/orders/:id~abc',
            path: 'livequery/spaces/space_xxx/status/running/orders/y8273678fgs8734~abc',
            params: {
                space_id: 'space_xxx',
                type: 'running',
                id: 'y8273678fgs8734',
            },
            method: 'GET'
        })

        new LivequeryRequestParser().handle(ctx)

        expect(ctx.livequery?.ref).toBe('spaces/space_xxx/status/running/orders/y8273678fgs8734')
        expect(ctx.livequery?.collection_ref).toBe('spaces/space_xxx/status/running/orders')
        expect(ctx.livequery?.schema_collection_ref).toBe('spaces/space_id/status/type/orders')
        expect(ctx.livequery?.document_id).toBe('y8273678fgs8734')
    })

    it('normalizes repeated and trailing slashes while parsing', () => {
        const ctx = createContext({
            ref: '//livequery//posts//:id//~listen',
            path: '//livequery//posts//abc//~listen',
            params: { id: 'abc' },
            method: 'GET'
        })

        new LivequeryRequestParser().handle(ctx)

        expect(ctx.livequery?.ref).toBe('posts/abc')
        expect(ctx.livequery?.collection_ref).toBe('posts')
        expect(ctx.livequery?.schema_collection_ref).toBe('posts')
        expect(ctx.livequery?.document_id).toBe('abc')
    })

    it('preserves params body and query on the parsed livequery request', () => {
        const body = { status: 'running' }
        const query = { expand: 'items' }
        const params = { id: 'order-1' }
        const ctx = createContext({
            ref: '/livequery/orders/:id',
            path: '/livequery/orders/order-1',
            params,
            query,
            body,
            method: 'PATCH'
        })

        new LivequeryRequestParser().handle(ctx)

        expect(ctx.livequery?.keys).toBe(params)
        expect(ctx.livequery?.body).toBe(body)
        expect(ctx.livequery?.query).toBe(query)
    })

    it('does not treat a tilde inside the query string as a hotkey suffix', () => {
        const ctx = createContext({
            ref: '/livequery/posts',
            path: '/livequery/posts?search=a~b',
            query: { search: 'a~b' },
            method: 'GET'
        })

        new LivequeryRequestParser().handle(ctx)

        expect(ctx.livequery?.ref).toBe('posts')
        expect(ctx.livequery?.collection_ref).toBe('posts')
        expect(ctx.livequery?.schema_collection_ref).toBe('posts')
        expect(ctx.livequery?.query).toEqual({ search: 'a~b' })
    })

    it('handles a route pattern that expects a document id when the path is missing it', () => {
        const ctx = createContext({
            ref: '/livequery/orders/:id',
            path: '/livequery/orders',
            params: {},
            method: 'GET'
        })

        new LivequeryRequestParser().handle(ctx)

        expect(ctx.livequery?.ref).toBe('orders')
        expect(ctx.livequery?.collection_ref).toBe('orders')
        expect(ctx.livequery?.document_id).toBeUndefined()
    })

    it('parses nested collection paths with parameter segments and no document id', () => {
        const ctx = createContext({
            ref: '/livequery/orgs/:org_id/users/:user_id/posts',
            path: '/livequery/orgs/org-1/users/user-1/posts',
            params: { org_id: 'org-1', user_id: 'user-1' },
            method: 'get'
        })

        new LivequeryRequestParser().handle(ctx)

        expect(ctx.livequery?.ref).toBe('orgs/org-1/users/user-1/posts')
        expect(ctx.livequery?.collection_ref).toBe('orgs/org-1/users/user-1/posts')
        expect(ctx.livequery?.schema_collection_ref).toBe('orgs/org_id/users/user_id/posts')
        expect(ctx.livequery?.document_id).toBeUndefined()
        expect(ctx.livequery?.method).toBe('GET')
    })

    it('normalizes mixed-case methods', () => {
        const ctx = createContext({
            path: '/livequery/posts/abc',
            ref: '/livequery/posts/:id',
            params: { id: 'abc' },
            method: 'pAtCh'
        })

        new LivequeryRequestParser().handle(ctx)

        expect(ctx.livequery?.method).toBe('PATCH')
    })

    it('parses paths without the livequery prefix', () => {
        const ctx = createContext({
            path: '/users/u1/posts/p1',
            ref: '/users/:uid/posts/:pid',
            params: { uid: 'u1', pid: 'p1' },
            method: 'patch'
        })

        new LivequeryRequestParser().handle(ctx)

        expect(ctx.livequery?.ref).toBe('users/u1/posts/p1')
        expect(ctx.livequery?.collection_ref).toBe('users/u1/posts')
        expect(ctx.livequery?.schema_collection_ref).toBe('users/uid/posts')
        expect(ctx.livequery?.document_id).toBe('p1')
        expect(ctx.livequery?.method).toBe('PATCH')
    })

    it('extracts the custom action verb from a ~suffix', () => {
        const ctx = createContext({
            ref: '/livequery/orders/:id~approve',
            path: '/livequery/orders/o1~approve',
            params: { id: 'o1' },
            method: 'POST'
        })

        new LivequeryRequestParser().handle(ctx)

        expect(ctx.livequery?.ref).toBe('orders/o1')
        expect(ctx.livequery?.document_id).toBe('o1')
        expect(ctx.livequery?.action).toBe('approve')
    })

    it('extracts the action verb from a separate ~segment and ignores the query string', () => {
        const ctx = createContext({
            ref: '/livequery/orders/:id/~approve',
            path: '/livequery/orders/o1/~approve?note=ok',
            params: { id: 'o1' },
            query: { note: 'ok' },
            method: 'POST'
        })

        new LivequeryRequestParser().handle(ctx)

        expect(ctx.livequery?.action).toBe('approve')
    })

    it('leaves action undefined when there is no ~suffix', () => {
        const ctx = createContext({
            path: '/livequery/posts',
            ref: '/livequery/posts',
            method: 'GET'
        })

        new LivequeryRequestParser().handle(ctx)

        expect(ctx.livequery?.action).toBeUndefined()
    })

    it('leaves livequery undefined for an empty path', () => {
        const ctx = createContext({
            path: '',
            ref: '',
            method: 'GET'
        })

        new LivequeryRequestParser().handle(ctx)

        expect(ctx.livequery).toBeUndefined()
    })
})

function createContext(options: {
    path: string
    ref: string
    query?: Record<string, any>
    params?: Record<string, any>
    body?: any
    method: string
}): LivequeryContext {
    return {
        request: {
            path: options.path,
            ref: options.ref,
            method: options.method,
            body: options.body,
            params: options.params ?? {},
            query: options.query ?? {},
            headers: new Map(),
        }
    }
}
