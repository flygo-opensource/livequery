import { describe, it, expect } from 'bun:test'
import { PathHelper } from '../src/helpers/PathHelper.js'

describe('PathHelper.parseHttpRequestPath', () => {
    it('parses a collection ref (odd segments)', () => {
        const result = PathHelper.parseHttpRequestPath('/livequery/posts')
        expect(result.ref).toBe('posts')
        expect(result.is_collection).toBe(true)
        expect(result.doc_id).toBeNull()
        expect(result.collection_ref).toBe('posts')
    })

    it('parses a document ref (even segments)', () => {
        const result = PathHelper.parseHttpRequestPath('/livequery/posts/abc123')
        expect(result.ref).toBe('posts/abc123')
        expect(result.is_collection).toBe(false)
        expect(result.doc_id).toBe('abc123')
        expect(result.collection_ref).toBe('posts')
    })

    it('parses nested collection ref', () => {
        const result = PathHelper.parseHttpRequestPath('/livequery/users/u1/posts')
        expect(result.ref).toBe('users/u1/posts')
        expect(result.is_collection).toBe(true)
        expect(result.collection_ref).toBe('users/u1/posts')
        expect(result.doc_id).toBeNull()
    })

    it('parses nested document ref', () => {
        const result = PathHelper.parseHttpRequestPath('/livequery/users/u1/posts/p1')
        expect(result.ref).toBe('users/u1/posts/p1')
        expect(result.is_collection).toBe(false)
        expect(result.doc_id).toBe('p1')
        expect(result.collection_ref).toBe('users/u1/posts')
    })

    it('strips colon params from path', () => {
        const result = PathHelper.parseHttpRequestPath('/livequery/users/:uid/posts/:pid')
        expect(result.ref).toBe('users/uid/posts/pid')
        expect(result.is_collection).toBe(false)
    })

    it('throws when magic key is missing', () => {
        expect(() => PathHelper.parseHttpRequestPath('/api/posts')).toThrow()
    })

    it('computes schema_ref from even-indexed segments', () => {
        const result = PathHelper.parseHttpRequestPath('/livequery/users/u1/posts/p1')
        expect(result.schema_ref).toBe('users/posts')
    })
})

describe('PathHelper.join', () => {
    it('joins two path segments', () => {
        expect(PathHelper.join('users', 'posts')).toEqual(['users/posts'])
    })

    it('joins arrays of segments', () => {
        expect(PathHelper.join(['a', 'b'], 'c')).toEqual(['a/c', 'b/c'])
    })

    it('removes empty segments', () => {
        expect(PathHelper.join('', 'posts')).toEqual(['posts'])
    })
})
