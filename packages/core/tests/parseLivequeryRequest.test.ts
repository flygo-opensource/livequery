import { describe, it, expect } from 'bun:test'
import { parseLivequeryHttpRequest, extractRealtimeSubscription } from '../src/parseLivequeryRequest.js'

describe('parseLivequeryHttpRequest', () => {
    it('parses a collection request', () => {
        const result = parseLivequeryHttpRequest({
            pathname: '/livequery/posts',
            routePath: '/livequery/posts',
            query: { ':limit': '20' },
            params: {},
            method: 'GET'
        })
        expect(result.ref).toBe('posts')
        expect(result.is_collection).toBe(true)
        expect(result.doc_id).toBeUndefined()
        expect(result.collection_ref).toBe('posts')
        expect(result.method).toBe('get')
        expect(result.options).toEqual({ ':limit': '20' })
    })

    it('parses a document request', () => {
        const result = parseLivequeryHttpRequest({
            pathname: '/livequery/posts/abc',
            routePath: '/livequery/posts/:id',
            query: {},
            params: { id: 'abc' },
            method: 'GET'
        })
        expect(result.ref).toBe('posts/abc')
        expect(result.is_collection).toBe(false)
        expect(result.doc_id).toBe('abc')
        expect(result.keys).toEqual({ id: 'abc' })
    })

    it('computes schema_collection_ref from route pattern', () => {
        const result = parseLivequeryHttpRequest({
            pathname: '/livequery/users/u1/posts',
            routePath: '/livequery/users/:uid/posts',
            query: {},
            params: { uid: 'u1' },
            method: 'GET'
        })
        // schema_collection_ref uses the route pattern with colon-params stripped (e.g. :uid → uid)
        expect(result.schema_collection_ref).toBe('users/uid/posts')
        expect(result.ref).toBe('users/u1/posts')
    })

    it('lowercases the method', () => {
        const result = parseLivequeryHttpRequest({
            pathname: '/livequery/posts',
            routePath: '/livequery/posts',
            query: {},
            params: {},
            method: 'POST',
            body: { title: 'Hello' }
        })
        expect(result.method).toBe('post')
        expect(result.body).toEqual({ title: 'Hello' })
    })
})

describe('extractRealtimeSubscription', () => {
    const nodeId = 'node-1'

    it('returns subscription when headers are valid and no cursor', () => {
        const sub = extractRealtimeSubscription(
            'posts',
            { 'x-lcid': 'client-1', 'x-lgid': 'gw-1' },
            {},
            nodeId
        )
        expect(sub).toEqual({
            ref: 'posts',
            client_id: 'client-1',
            gateway_id: 'gw-1',
            listener_node_id: nodeId
        })
    })

    it('uses gatewayId fallback when x-lgid missing', () => {
        const sub = extractRealtimeSubscription(
            'posts',
            { 'x-lcid': 'client-1' },
            {},
            nodeId,
            'fallback-gw'
        )
        expect(sub?.gateway_id).toBe('fallback-gw')
    })

    it('uses socket_id header as fallback for client_id', () => {
        const sub = extractRealtimeSubscription(
            'posts',
            { 'socket_id': 'client-2', 'x-lgid': 'gw-1' },
            {},
            nodeId
        )
        expect(sub?.client_id).toBe('client-2')
    })

    it('returns null when client_id is missing', () => {
        const sub = extractRealtimeSubscription('posts', { 'x-lgid': 'gw-1' }, {}, nodeId)
        expect(sub).toBeNull()
    })

    it('returns null when gateway_id is missing', () => {
        const sub = extractRealtimeSubscription('posts', { 'x-lcid': 'client-1' }, {}, nodeId)
        expect(sub).toBeNull()
    })

    it('returns null when :after cursor is present', () => {
        const sub = extractRealtimeSubscription(
            'posts',
            { 'x-lcid': 'client-1', 'x-lgid': 'gw-1' },
            { ':after': 'cursor-xyz' },
            nodeId
        )
        expect(sub).toBeNull()
    })

    it('returns null when :before cursor is present', () => {
        const sub = extractRealtimeSubscription(
            'posts',
            { 'x-lcid': 'client-1', 'x-lgid': 'gw-1' },
            { ':before': 'cursor-xyz' },
            nodeId
        )
        expect(sub).toBeNull()
    })

    it('returns null when :around cursor is present', () => {
        const sub = extractRealtimeSubscription(
            'posts',
            { 'x-lcid': 'client-1', 'x-lgid': 'gw-1' },
            { ':around': 'cursor-xyz' },
            nodeId
        )
        expect(sub).toBeNull()
    })
})
