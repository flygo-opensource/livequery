import type { Context } from 'hono'
import { hidePrivateFields } from '@livequery/core'
import type { LivequeryResponse } from './types.js'

export function mapLivequeryResponse<T extends LivequeryResponse>(response: T): T {
    if (response.item) {
        return {
            ...response,
            item: hidePrivateFields(toPlain(response.item) as never),
        }
    }

    if (response.items) {
        return {
            ...response,
            items: response.items.map(item => hidePrivateFields(toPlain(item) as never)),
        }
    }

    return response
}

export function livequeryJson<T extends LivequeryResponse>(
    c: Context,
    response: T,
    status?: number
): Response {
    return c.json(mapLivequeryResponse(response), status as never)
}

function toPlain(item: unknown): Record<string, unknown> {
    if (item && typeof item === 'object' && 'toJSON' in item && typeof item.toJSON === 'function') {
        return item.toJSON() as Record<string, unknown>
    }
    return item as Record<string, unknown>
}
