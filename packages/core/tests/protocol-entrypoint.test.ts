import { describe, expect, test } from 'bun:test'
import {
    LIVEQUERY_REALTIME_PATH,
    LivequeryRequestParser,
    hidePrivateFields,
    type LivequerySyncEvent,
    type UpdatedData,
} from '../src/index.js'

describe('protocol entrypoint', () => {
    test('exports only runtime-independent protocol primitives', () => {
        expect(LIVEQUERY_REALTIME_PATH).toBe('/livequery/realtime-updates')
        expect(typeof LivequeryRequestParser.parse).toBe('function')
        expect(typeof hidePrivateFields).toBe('function')
    })

    test('keeps the canonical realtime sync shape', () => {
        const change: UpdatedData = {
            ref: 'projects/p1/machines',
            type: 'modified',
            data: { id: 'm1' },
        }
        const event: LivequerySyncEvent = {
            event: 'sync',
            data: { changes: [change] },
        }

        expect(event.data?.changes[0]).toEqual(change)
    })
})
