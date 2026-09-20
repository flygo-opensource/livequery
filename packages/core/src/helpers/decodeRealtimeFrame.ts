import { decodeMsgpack } from './decodeMsgpack.js'

const text_decoder = new TextDecoder()

function isJsonText(bytes: Uint8Array): boolean {
    for (const byte of bytes) {
        // Skip JSON whitespace; the first real byte of a JSON frame is `{` or `[`.
        if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue
        return byte === 0x7b || byte === 0x5b
    }
    return false
}

/**
 * Decode one realtime frame. Text frames are JSON. Binary frames are JSON text when a runtime
 * hands text frames over as bytes (Node `ws` does), otherwise MessagePack, which clients send
 * after a `hello` with `binary: true`. A MessagePack frame never starts with `{` or `[`, because
 * those bytes are positive integers there, never a map or array.
 */
export function decodeRealtimeFrame(raw: string | ArrayBuffer | ArrayBufferView): unknown {
    if (typeof raw === 'string') return JSON.parse(raw)
    const bytes = raw instanceof ArrayBuffer
        ? new Uint8Array(raw)
        : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
    if (isJsonText(bytes)) return JSON.parse(text_decoder.decode(bytes))
    return decodeMsgpack(bytes)
}
