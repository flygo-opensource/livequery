import type { LivequeryRequest } from '@livequery/core'
import { hidePrivateFields } from '@livequery/core'
import { D1Query } from './D1Query.js'
import type { D1RouteOptions } from './types.js'

export class D1Datasource {

    async #resolveTable(req: LivequeryRequest, options: D1RouteOptions): Promise<string> {
        return typeof options.table === 'function' ? options.table(req) : options.table
    }

    async query<T extends { id: string }>(
        db: D1Database,
        req: LivequeryRequest,
        options: D1RouteOptions
    ) {
        const table = await this.#resolveTable(req, options)
        const is_collection = !req.document_id

        if (is_collection) {
            const result = await D1Query.queryCollection<T>(db, table, req)
            return {
                ...result,
                items: result.items.map(item => hidePrivateFields({ item }).item as T),
            }
        }

        const result = await D1Query.queryDocument<T>(db, table, req)
        if (!result.item) throw { status: 404, code: 'NOT_FOUND', message: 'Document not found' }
        return { item: hidePrivateFields({ item: result.item }).item as T }
    }

    async add<T extends { id: string }>(
        db: D1Database,
        req: LivequeryRequest,
        options: D1RouteOptions
    ): Promise<{ item: T }> {
        const table = await this.#resolveTable(req, options)
        const body = req.body as Record<string, unknown> ?? {}
        // Strip any client-provided id (e.g. optimistic local:UUID) — always generate server-side
        const { id: _clientId, ...rest } = body
        const data = { ...req.keys, ...rest, id: crypto.randomUUID() }
        const item = await D1Query.insert<T>(db, table, data)
        return { item: hidePrivateFields({ item }).item as T }
    }

    async update<T extends { id: string }>(
        db: D1Database,
        req: LivequeryRequest,
        options: D1RouteOptions
    ): Promise<{ item: T }> {
        const table = await this.#resolveTable(req, options)
        const id = req.document_id
        if (!id) throw { status: 400, code: 'MISSING_ID', message: 'Document id is required for update' }
        const body = req.body as Record<string, unknown> ?? {}
        const item = await D1Query.update<T>(db, table, id, body, req.keys)
        return { item: hidePrivateFields({ item }).item as T }
    }

    async delete<T extends { id: string }>(
        db: D1Database,
        req: LivequeryRequest,
        options: D1RouteOptions
    ): Promise<{ item: T }> {
        const table = await this.#resolveTable(req, options)
        const id = req.document_id
        if (!id) throw { status: 400, code: 'MISSING_ID', message: 'Document id is required for delete' }
        const item = await D1Query.delete<T>(db, table, id, req.keys)
        return { item }
    }

    async handle<T extends { id: string }>(
        db: D1Database,
        req: LivequeryRequest | undefined,
        options: D1RouteOptions
    ) {
        if (!req) throw { status: 400, code: 'INVALID_REQUEST', message: 'Invalid livequery request' }

        const method = req.method?.toLowerCase()

        if (method === 'get') return this.query<T>(db, req, options)
        if (method === 'post') return this.add<T>(db, req, options)
        if (method === 'put' || method === 'patch') return this.update<T>(db, req, options)
        if (method === 'delete') return this.delete<T>(db, req, options)

        throw { status: 405, code: 'METHOD_NOT_ALLOWED', message: `Method ${req.method} not allowed` }
    }
}
