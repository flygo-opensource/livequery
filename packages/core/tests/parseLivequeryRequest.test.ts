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

    it('exposes the parser as a reusable static method', () => {
        const ctx = createContext({
            path: '/livequery/posts/abc',
            ref: '/livequery/posts/:id',
            params: { id: 'abc' },
            method: 'GET'
        })

        const parsed = LivequeryRequestParser.parse(ctx.request)

        expect(parsed?.ref).toBe('posts/abc')
        expect(parsed?.collection_ref).toBe('posts')
        expect(parsed?.document_id).toBe('abc')
        expect(parsed?.keys).toEqual({ id: 'abc' })
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
        expect(ctx.livequery?.schema).toBe('users/:uid/posts')
        expect(ctx.livequery?.collection).toBe('posts')
        expect(ctx.livequery?.ref).toBe('users/u1/posts')
    })

    it('keeps static route segments out of keys and preserves them in schema', () => {
        const ctx = createContext({
            path: '/livequery/spaces/s1/tools/livestream-product-manager/lists',
            ref: '/livequery/spaces/:space_id/tools/livestream-product-manager/lists',
            params: {
                space_id: 's1',
                tool: 'should-not-leak',
            },
            method: 'GET'
        })

        new LivequeryRequestParser().handle(ctx)

        expect(ctx.livequery?.ref).toBe('spaces/s1/tools/livestream-product-manager/lists')
        expect(ctx.livequery?.collection_ref).toBe('spaces/s1/tools/livestream-product-manager/lists')
        expect(ctx.livequery?.collection).toBe('lists')
        expect(ctx.livequery?.schema).toBe('spaces/:space_id/tools/livestream-product-manager/lists')
        expect(ctx.livequery?.schema_collection_ref).toBe('spaces/space_id/tools/livestream-product-manager/lists')
        expect(ctx.livequery?.keys).toEqual({ space_id: 's1' })
    })

    it('parses document routes under static aliases without treating static segments as keys', () => {
        const ctx = createContext({
            path: '/livequery/spaces/s1/tools/livestream-product-manager/lists/list-1',
            ref: '/livequery/spaces/:space_id/tools/livestream-product-manager/lists/:id',
            params: {
                space_id: 's1',
                id: 'list-1',
                tools: 'should-not-leak',
                'livestream-product-manager': 'should-not-leak',
            },
            method: 'GET'
        })

        new LivequeryRequestParser().handle(ctx)

        expect(ctx.livequery?.ref).toBe('spaces/s1/tools/livestream-product-manager/lists/list-1')
        expect(ctx.livequery?.collection_ref).toBe('spaces/s1/tools/livestream-product-manager/lists')
        expect(ctx.livequery?.collection).toBe('lists')
        expect(ctx.livequery?.schema).toBe('spaces/:space_id/tools/livestream-product-manager/lists')
        expect(ctx.livequery?.schema_collection_ref).toBe('spaces/space_id/tools/livestream-product-manager/lists')
        expect(ctx.livequery?.document_id).toBe('list-1')
        expect(ctx.livequery?.keys).toEqual({ space_id: 's1', id: 'list-1' })
    })

    it('parses nested static alias document actions with query strings', () => {
        const ctx = createContext({
            path: '/livequery/spaces/s1/tools/livestream-product-manager/lists/list-1/products/product-9~pin?source=ui',
            ref: '/livequery/spaces/:space_id/tools/livestream-product-manager/lists/:list_id/products/:product_id~pin',
            params: {
                space_id: 's1',
                list_id: 'list-1',
                product_id: 'product-9',
                source: 'should-not-leak',
            },
            query: { source: 'ui' },
            method: 'POST'
        })

        new LivequeryRequestParser().handle(ctx)

        expect(ctx.livequery?.ref).toBe('spaces/s1/tools/livestream-product-manager/lists/list-1/products/product-9')
        expect(ctx.livequery?.collection_ref).toBe('spaces/s1/tools/livestream-product-manager/lists/list-1/products')
        expect(ctx.livequery?.collection).toBe('products')
        expect(ctx.livequery?.schema).toBe('spaces/:space_id/tools/livestream-product-manager/lists/:list_id/products')
        expect(ctx.livequery?.schema_collection_ref).toBe('spaces/space_id/tools/livestream-product-manager/lists/list_id/products')
        expect(ctx.livequery?.document_id).toBe('product-9')
        expect(ctx.livequery?.action).toBe('pin')
        expect(ctx.livequery?.query).toEqual({ source: 'ui' })
        expect(ctx.livequery?.keys).toEqual({
            space_id: 's1',
            list_id: 'list-1',
            product_id: 'product-9',
        })
    })

    it('preserves static collection names after multiple dynamic route segments', () => {
        const ctx = createContext({
            path: '/livequery/spaces/s1/accounts/a1/tools/livestream-product-manager/lists',
            ref: '/livequery/spaces/:space_id/accounts/:account_id/tools/livestream-product-manager/lists',
            params: {
                space_id: 's1',
                account_id: 'a1',
                list_id: 'should-not-leak',
            },
            method: 'GET'
        })

        new LivequeryRequestParser().handle(ctx)

        expect(ctx.livequery?.ref).toBe('spaces/s1/accounts/a1/tools/livestream-product-manager/lists')
        expect(ctx.livequery?.collection_ref).toBe('spaces/s1/accounts/a1/tools/livestream-product-manager/lists')
        expect(ctx.livequery?.collection).toBe('lists')
        expect(ctx.livequery?.schema).toBe('spaces/:space_id/accounts/:account_id/tools/livestream-product-manager/lists')
        expect(ctx.livequery?.schema_collection_ref).toBe('spaces/space_id/accounts/account_id/tools/livestream-product-manager/lists')
        expect(ctx.livequery?.document_id).toBeUndefined()
        expect(ctx.livequery?.keys).toEqual({ space_id: 's1', account_id: 'a1' })
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

        expect(ctx.livequery?.keys).toEqual(params)
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

    it('rejects paths without the livequery prefix', () => {
        const ctx = createContext({
            path: '/users/u1/posts/p1',
            ref: '/users/:uid/posts/:pid',
            params: { uid: 'u1', pid: 'p1' },
            method: 'patch'
        })

        expect(() => new LivequeryRequestParser().handle(ctx)).toThrow('Livequery path must start with "livequery"')
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

    it('rejects an empty path', () => {
        const ctx = createContext({
            path: '',
            ref: '',
            method: 'GET'
        })

        expect(() => new LivequeryRequestParser().handle(ctx)).toThrow('Livequery path must start with "livequery"')
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
