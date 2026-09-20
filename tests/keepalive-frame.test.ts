/**
 * The keep-alive frame is a wire-protocol constant, and it lives in two places: `@livequery/core`
 * for the server, and `@livequery/rest` for the browser client, which keeps a literal copy so a
 * frontend bundle does not pull in the server package.
 *
 * This test is what stops the two from drifting. If it fails, do not "fix" one side: on Cloudflare
 * the runtime answers the ping through `setWebSocketAutoResponse`, comparing the frame as an exact
 * string, so a mismatch means every idle client wakes its Durable Object once a minute — working
 * software with a quietly growing bill, which no other test would catch.
 */
import { describe, expect, test } from 'bun:test'
import { LIVEQUERY_PING_FRAME, LIVEQUERY_PONG_FRAME } from '../core/build/src/index.js'
import { LIVEQUERY_PING_FRAME as CLIENT_PING_FRAME } from '../rest/src/Socket.js'

describe('keep-alive frame', () => {
    test('client and server agree byte for byte', () => {
        expect(CLIENT_PING_FRAME).toBe(LIVEQUERY_PING_FRAME)
    })

    test('the frames are the canonical JSON encodings', () => {
        expect(LIVEQUERY_PING_FRAME).toBe(JSON.stringify({ event: 'ping' }))
        expect(LIVEQUERY_PONG_FRAME).toBe(JSON.stringify({ event: 'pong' }))
    })

    test('no whitespace, no extra field, no trailing newline', () => {
        expect(LIVEQUERY_PING_FRAME).toBe('{"event":"ping"}')
        expect(Object.keys(JSON.parse(LIVEQUERY_PING_FRAME))).toEqual(['event'])
    })
})
