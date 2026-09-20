import { LIVEQUERY_PING_FRAME } from '../const.js'

const PING_BYTES = new TextEncoder().encode(LIVEQUERY_PING_FRAME)

/**
 * Is this frame the keep-alive ping, byte for byte?
 *
 * The comparison is deliberately exact rather than "decode it and look at `event`": on Cloudflare
 * the runtime answers this frame through `setWebSocketAutoResponse`, which matches the raw string
 * and nothing else. Accepting a looser spelling here would let a client drift into a frame that
 * this gateway answers but the Workers runtime does not — the object would then be woken by every
 * idle ping, with no failing test anywhere.
 *
 * Node's `ws` hands text frames over as a Buffer, so bytes are compared too. The length check
 * makes that O(1) for every other frame.
 */
export function isPingFrame(raw: string | ArrayBuffer | ArrayBufferView): boolean {
    if (typeof raw === 'string') return raw === LIVEQUERY_PING_FRAME
    const bytes = raw instanceof ArrayBuffer
        ? new Uint8Array(raw)
        : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
    if (bytes.byteLength !== PING_BYTES.length) return false
    return PING_BYTES.every((byte, index) => bytes[index] === byte)
}
