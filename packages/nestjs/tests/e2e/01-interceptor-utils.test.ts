import 'reflect-metadata'
import { describe, test, expect } from 'bun:test'
import { Controller, Get } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { LivequeryRequestParser, hidePrivateFields, type LivequeryContext } from '@livequery/core'
import { LivequeryDatasourceInterceptors } from '../../src/LivequeryDatasourceInterceptors.js'

// ─── LivequeryRequestParser ───────────────────────────────────────────────────

describe('LivequeryRequestParser', () => {
    test('collection ref: odd number of segments', () => {
        const r = parse('/livequery/users')
        expect(r?.ref).toBe('users')
        expect(r?.document_id).toBeUndefined()
        expect(r?.collection_ref).toBe('users')
    })

    test('document ref: even number of segments', () => {
        const r = parse('/livequery/users/123', '/livequery/users/:id', { id: '123' })
        expect(r?.ref).toBe('users/123')
        expect(r?.collection_ref).toBe('users')
        expect(r?.document_id).toBe('123')
    })

    test('nested collection ref: 3 segments', () => {
        const r = parse('/livequery/users/123/posts', '/livequery/users/:id/posts', { id: '123' })
        expect(r?.ref).toBe('users/123/posts')
        expect(r?.collection_ref).toBe('users/123/posts')
        expect(r?.document_id).toBeUndefined()
    })

    test('nested document ref: 4 segments', () => {
        const r = parse('/livequery/users/123/posts/456', '/livequery/users/:uid/posts/:pid', { uid: '123', pid: '456' })
        expect(r?.ref).toBe('users/123/posts/456')
        expect(r?.collection_ref).toBe('users/123/posts')
        expect(r?.document_id).toBe('456')
    })

    test('strips colons from path (param syntax)', () => {
        const r = parse('/livequery/users/123', '/livequery/users/:id', { id: '123' })
        expect(r?.document_id).toBe('123')
    })

    test('schema_collection_ref contains collection schema segments', () => {
        const r = parse('/livequery/users/123/posts/456', '/livequery/users/:uid/posts/:pid', { uid: '123', pid: '456' })
        expect(r?.schema_collection_ref).toBe('users/uid/posts')
    })
})

// ─── LivequeryDatasourceInterceptors route metadata ───────────────────────────

describe('LivequeryDatasourceInterceptors', () => {
    test('uses core parser schema for datasource routes with static aliases', () => {
        const datasource = Symbol('datasource')

        @Controller([
            'livequery/spaces/:space_id/tools/livestream-product-manager/lists',
            'livequery/tool-livestream-products/:space_id/product-lists',
        ])
        class ProductListsController {
            @Get(['', ':id', ':id/~pull-products'])
            list() { }
        }

        Reflect.defineMetadata(
            LivequeryDatasourceInterceptors,
            { datasource, options: { realtime: true } },
            ProductListsController.prototype.list
        )

        const interceptor = new LivequeryDatasourceInterceptors(
            new Reflector(),
            { getControllers: () => [{ metatype: ProductListsController }] } as any,
            {} as any
        )

        const routes = interceptor.getRoutes(datasource)

        const staticAliasRoutes = routes.filter(route => route.path === 'spaces/:space_id/tools/livestream-product-manager/lists')
        const legacyAliasRoutes = routes.filter(route => route.path === 'tool-livestream-products/:space_id/product-lists')

        expect(staticAliasRoutes).toHaveLength(3)
        expect(legacyAliasRoutes).toHaveLength(3)
        // getRoutes maps NestJS's RequestMethod enum number to its verb string so
        // datasource route tables (keyed "GET <schema>") and watchers get real verbs.
        expect(staticAliasRoutes.every(route => route.method === 'GET' && route.options.realtime === true)).toBe(true)
        expect(legacyAliasRoutes.every(route => route.method === 'GET' && route.options.realtime === true)).toBe(true)
        expect(routes.some(route => route.path.includes('livestream-product-manager'))).toBe(true)
        expect(routes.some(route => route.path.includes('spaces/space_id/tools'))).toBe(false)
    })
})

// ─── hidePrivateFields ────────────────────────────────────────────────────────

describe('hidePrivateFields', () => {
    test('removes underscore-prefixed fields', () => {
        const result = hidePrivateFields({ id: '1', name: 'Alice', _password: 'secret' })
        expect(result).not.toHaveProperty('_password')
        expect(result.name).toBe('Alice')
    })

    test('preserves id field', () => {
        const result = hidePrivateFields({ id: '42', value: 10 })
        expect(result.id).toBe('42')
    })

    test('promotes _id to id when id is absent', () => {
        const result = hidePrivateFields({ _id: 'mongo-id-123' } as any)
        expect(result.id).toBe('mongo-id-123')
    })

    test('removes all underscore fields', () => {
        const result = hidePrivateFields({ id: '1', _a: 1, _b: 2, pub: 'ok' })
        expect(Object.keys(result)).not.toContain('_a')
        expect(Object.keys(result)).not.toContain('_b')
        expect((result as any).pub).toBe('ok')
    })
})

function parse(path: string, ref = path, params: Record<string, any> = {}) {
    const ctx: LivequeryContext = {
        request: {
            path,
            ref,
            params,
            query: {},
            method: 'GET',
            headers: new Map(),
        }
    }
    new LivequeryRequestParser().handle(ctx)
    return ctx.livequery
}
