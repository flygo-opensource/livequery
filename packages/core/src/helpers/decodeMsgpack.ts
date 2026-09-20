type Reader = { view: DataView; bytes: Uint8Array; offset: number }

const text_decoder = new TextDecoder()

function take(r: Reader, length: number): number {
    const start = r.offset
    if (start + length > r.bytes.length) throw new RangeError('msgpack: unexpected end of input')
    r.offset += length
    return start
}

function readString(r: Reader, length: number): string {
    const start = take(r, length)
    return text_decoder.decode(r.bytes.subarray(start, start + length))
}

function readArray(r: Reader, length: number): unknown[] {
    const out: unknown[] = []
    for (let i = 0; i < length; i++) out.push(readValue(r))
    return out
}

function readMap(r: Reader, length: number): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (let i = 0; i < length; i++) {
        const key = readValue(r)
        // Frames are JSON-shaped; a non-string key (or `__proto__`) has no place in one.
        if (typeof key !== 'string' && typeof key !== 'number') throw new TypeError('msgpack: unsupported map key')
        const name = String(key)
        const value = readValue(r)
        if (name === '__proto__') continue
        out[name] = value
    }
    return out
}

function readExt(r: Reader, length: number): unknown {
    const type = r.view.getInt8(take(r, 1))
    const start = take(r, length)
    // -1 is the msgpack timestamp extension, which @msgpack/msgpack emits for Date.
    if (type !== -1) throw new TypeError(`msgpack: unsupported extension type ${type}`)
    if (length === 4) return new Date(r.view.getUint32(start) * 1000)
    if (length === 8) {
        const high = r.view.getUint32(start)
        const low = r.view.getUint32(start + 4)
        const nanoseconds = high >>> 2
        const seconds = (high & 0x3) * 0x100000000 + low
        return new Date(seconds * 1000 + nanoseconds / 1e6)
    }
    if (length === 12) {
        const nanoseconds = r.view.getUint32(start)
        const seconds = Number(r.view.getBigInt64(start + 4))
        return new Date(seconds * 1000 + nanoseconds / 1e6)
    }
    throw new TypeError('msgpack: invalid timestamp length')
}

function readValue(r: Reader): unknown {
    const byte = r.view.getUint8(take(r, 1))
    if (byte <= 0x7f) return byte
    if (byte <= 0x8f) return readMap(r, byte & 0x0f)
    if (byte <= 0x9f) return readArray(r, byte & 0x0f)
    if (byte <= 0xbf) return readString(r, byte & 0x1f)
    if (byte >= 0xe0) return byte - 0x100

    const { view } = r
    switch (byte) {
        case 0xc0: return null
        case 0xc2: return false
        case 0xc3: return true
        case 0xc4: return readBin(r, view.getUint8(take(r, 1)))
        case 0xc5: return readBin(r, view.getUint16(take(r, 2)))
        case 0xc6: return readBin(r, view.getUint32(take(r, 4)))
        case 0xc7: return readExt(r, view.getUint8(take(r, 1)))
        case 0xc8: return readExt(r, view.getUint16(take(r, 2)))
        case 0xc9: return readExt(r, view.getUint32(take(r, 4)))
        case 0xca: return view.getFloat32(take(r, 4))
        case 0xcb: return view.getFloat64(take(r, 8))
        case 0xcc: return view.getUint8(take(r, 1))
        case 0xcd: return view.getUint16(take(r, 2))
        case 0xce: return view.getUint32(take(r, 4))
        case 0xcf: return Number(view.getBigUint64(take(r, 8)))
        case 0xd0: return view.getInt8(take(r, 1))
        case 0xd1: return view.getInt16(take(r, 2))
        case 0xd2: return view.getInt32(take(r, 4))
        case 0xd3: return Number(view.getBigInt64(take(r, 8)))
        case 0xd4: return readExt(r, 1)
        case 0xd5: return readExt(r, 2)
        case 0xd6: return readExt(r, 4)
        case 0xd7: return readExt(r, 8)
        case 0xd8: return readExt(r, 16)
        case 0xd9: return readString(r, view.getUint8(take(r, 1)))
        case 0xda: return readString(r, view.getUint16(take(r, 2)))
        case 0xdb: return readString(r, view.getUint32(take(r, 4)))
        case 0xdc: return readArray(r, view.getUint16(take(r, 2)))
        case 0xdd: return readArray(r, view.getUint32(take(r, 4)))
        case 0xde: return readMap(r, view.getUint16(take(r, 2)))
        case 0xdf: return readMap(r, view.getUint32(take(r, 4)))
    }
    throw new TypeError(`msgpack: invalid byte 0x${byte.toString(16)}`)
}

function readBin(r: Reader, length: number): Uint8Array {
    const start = take(r, length)
    return r.bytes.slice(start, start + length)
}

/**
 * Decode one MessagePack value. Covers the full format except extension types other than
 * timestamps, which is everything a Livequery client frame can contain. Throws on malformed
 * or trailing input.
 */
export function decodeMsgpack(input: ArrayBuffer | ArrayBufferView): unknown {
    const bytes = input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    const reader: Reader = { view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), bytes, offset: 0 }
    const value = readValue(reader)
    if (reader.offset !== bytes.length) throw new RangeError('msgpack: trailing bytes after value')
    return value
}
