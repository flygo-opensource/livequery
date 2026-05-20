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
