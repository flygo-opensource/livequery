import { describe, expect, test } from 'bun:test'
import { encode } from '@msgpack/msgpack'
import { decodeMsgpack, decodeRealtimeFrame } from '../src/index.js'

// ─── decodeMsgpack ─────────────────────────────────────────────────────────────

describe('decodeMsgpack', () => {
    const values: Array<[string, unknown]> = [
        ['nil', null],
        ['booleans', [true, false]],
        ['positive fixint', 127],
        ['negative fixint', -32],
        ['uint8 / uint16 / uint32', [200, 60000, 4000000000]],
        ['int8 / int16 / int32', [-100, -30000, -2000000000]],
        ['64-bit integers', [2 ** 53 - 1, -(2 ** 53 - 1)]],
        ['float64', 3.14159],
        ['fixstr and str8 / str16', ['a', 'x'.repeat(40), 'y'.repeat(300)]],
        ['utf-8 text', 'Tiếng Việt ✓ 🚀'],
        ['fixarray and array16', [Array.from({ length: 3 }, (_, i) => i), Array.from({ length: 20 }, (_, i) => i)]],
        ['map16', Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]))],
        ['nested frame', { event: 'unsubscribe', data: { ref: 'tasks', refs: ['a', 'b/c'] } }],
    ]

    for (const [name, value] of values) {
        test(`${name} — matches the @msgpack/msgpack encoding`, () => {
            expect(decodeMsgpack(encode(value))).toEqual(value)
        })
    }

    test('binary and timestamp values', () => {
        const date = new Date('2026-09-18T10:20:30.456Z')
        const decoded = decodeMsgpack(encode({ bytes: new Uint8Array([1, 2, 3]), at: date })) as {
            bytes: Uint8Array
            at: Date
        }
        expect([...decoded.bytes]).toEqual([1, 2, 3])
        expect(decoded.at.getTime()).toBe(date.getTime())
    })

    test('truncated or trailing input — throws', () => {
        const bytes = encode({ event: 'ping' })
        expect(() => decodeMsgpack(bytes.subarray(0, bytes.length - 1))).toThrow()
        expect(() => decodeMsgpack(new Uint8Array([...bytes, 0xc0]))).toThrow()
        expect(() => decodeMsgpack(new Uint8Array([0xc1]))).toThrow()
    })

    test('__proto__ keys are dropped', () => {
        const decoded = decodeMsgpack(encode(JSON.parse('{"__proto__":{"polluted":true},"ok":1}'))) as object
        expect(decoded).toEqual({ ok: 1 })
        expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
    })
})

// ─── decodeRealtimeFrame ───────────────────────────────────────────────────────

describe('decodeRealtimeFrame', () => {
    const frame = { event: 'unsubscribe', data: { ref: 'tasks' } }

    test('text frame — parsed as JSON', () => {
        expect(decodeRealtimeFrame(JSON.stringify(frame))).toEqual(frame)
    })

    test('JSON text delivered as bytes (Node ws) — parsed as JSON', () => {
        expect(decodeRealtimeFrame(Buffer.from(` ${JSON.stringify(frame)}`))).toEqual(frame)
        expect(decodeRealtimeFrame(new TextEncoder().encode(JSON.stringify(frame)).buffer)).toEqual(frame)
    })

    test('msgpack frame as Uint8Array, Buffer or ArrayBuffer — decoded', () => {
        const bytes = encode(frame)
        expect(decodeRealtimeFrame(bytes)).toEqual(frame)
        expect(decodeRealtimeFrame(Buffer.from(bytes))).toEqual(frame)
        expect(decodeRealtimeFrame(bytes.slice().buffer)).toEqual(frame)
    })
})
